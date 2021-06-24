const axios = require('axios').default;
const inquirer = require('inquirer');
const Configstore = require('configstore');
const path = require('path');
const chalk = require('chalk');
const figlet = require('figlet');
const Downloader = require('nodejs-file-downloader');

/**
 * Local configuration store to persists course ID and CAUTH value
 */
const config = new Configstore('coursera-asset-scraper', require('./config_default.json'), {
    configPath: `${path.join(__dirname, 'config.json')}`,
});

const app = (() => {
    /**
     * The course ID which can be found in the Coursera URL
     * E.g. 'convolutional-neural-networks' from https://www.coursera.org/learn/convolutional-neural-networks
     */
    let _cid;
    /**
     * The CAUTH value which is part of the Coursera cookie once the user authenticates on the platform.
     * You can find this value in Chrome by opening the inspector and going to
     * Application => Cookies => 'www.coursera.org' => CAUTH
     */
    let _cauth;

    /**
     * The ID of the authenticated user
     */
    let _uid;

    /**
     * The course defails as returned by the `guidedCourseWeekCards.v1` API
     */
    let _courseDetails;

    const api = {
        main,
    };

    /**
     * A shortcut to the console.log function
     */
    const { log } = console;

    /**
     * Pads integer `i` with leading zero
     * @param {int} i Integer to pad
     * @returns {string} Zero-padded string value
     */
    function padZero(i) {
        return String(i).padStart(2, '0');
    }

    /**
     * Prompts the user for the course id
     * @returns {string} The course id
     */
    async function promptCourse() {
        const res = await inquirer.prompt({
            name: 'cid',
            type: 'input',
            message: "Enter course ID (e.g. 'neural-networks-deep-learning'):",
            get default() {
                return config.get('cid');
            },
            validate: (val) => !!val,
        });

        return res.cid;
    }

    /**
     * Prompts the user for the CAUTH value which is set in the Coursera cookie
     * @returns {string} The CAUTH value
     */
    async function promptCauth() {
        const res = await inquirer.prompt({
            name: 'cauth',
            type: 'input',
            message: 'Enter CAUTH value from Coursera cookie:',
            get default() {
                return config.get('cauth');
            },
            validate: (val) => !!val,
        });

        return res.cauth;
    }

    /**
     * Prompts the user for the course ID and CAUTH value and stores them in the local configuration store
     */
    async function getCourseAndCauth() {
        _cauth = await promptCauth();
        config.set('cauth', _cauth);
        _cid = await promptCourse();
        config.set('cid', _cid);
    }

    /**
     * Gets the user ID as authenticated by the CAUTH value using the `adminUserPermissions.v1` API
     * @returns {string} The user ID
     */
    async function getUserId() {
        const res = await axios
            .get('https://www.coursera.org/api/adminUserPermissions.v1?q=my', {
                headers: { Cookie: `CAUTH=${_cauth}` },
            })
            .catch((err) => {
                throw err + '\nUnable to authenticate. Make sure you set CAUTH value correctly.\n';
            });
        _uid = res.data.elements[0].id;
        if (!_uid) {
            throw '\nUnable to authenticate. Make sure you set CAUTH value correctly.\n';
        }
        return _uid;
    }

    /**
     * Gets the course details for the course ID using CAUTH to authenticate. Uses the `guidedCourseWeekCards.v1` API.
     * @returns {object} An object containing the course details.
     */
    async function getCourseDetails() {
        const res = await axios
            .get(`https://www.coursera.org/api/guidedCourseWeekCards.v1?ids=${_uid}~${_cid}&fields=courseId,id,weeks`, {
                headers: { Cookie: `CAUTH=${_cauth}` },
            })
            .catch((err) => {
                throw (
                    err +
                    '\nnUnable to fetch course details. Make sure you set the course ID and CAUTH value correctly and that you have access to this course.\n'
                );
            });
        _courseDetails = res.data.elements[0];
        if (!_courseDetails) {
            throw '\nUnable to fetch course details. Make sure you set the course ID and CAUTH value correctly and that you have access to this course.\n';
        }
        return _courseDetails;
    }

    /**
     * Downloads the source file for the given module asset.
     * @param {int} assetNum The numerical sequence of the asset (i.e. 01, 02, 03, ...)
     * @param {object} asset The asset object extracted from the response of `onDemandLectureAssets.v1` API
     * @param {int} moduleNum The numerical sequence of the module (i.e. 01, 02, 03, ...)
     * @param {object} module The week object extracted from the course details
     * @param {int} weekNum The numerical sequence of the week (i.e. 01, 02, 03, ...)
     * @param {object} week The week object extracted from the course details
     */
    async function scrapeAsset(assetNum, asset, moduleNum, module, weekNum, week) {
        if (asset && asset.typeName && asset.typeName == 'url') {
            log(
                `      ${chalk.white('Asset')} ${chalk.yellow(
                    `#${padZero(assetNum)} - ` + `Skipping URL ${asset.definition.name}`
                )}`
            );
            return;
        } else
            log(
                `      ${chalk.white('Asset')} ${chalk.yellow(
                    `#${padZero(assetNum)} - ` + `Downloading ${asset.definition.name}`
                )}`
            );

        const resAsset = await axios
            .get(`https://www.coursera.org/api/assets.v1/${asset.definition.assetId}?fields=fileExtension`, {
                headers: { Cookie: `CAUTH=${_cauth}` },
            })
            .catch((err) => {
                throw err + '\nUnable to download asset.\n';
            });
        const { url } = resAsset.data.elements[0].url;
        const fileName = `${padZero(assetNum)} - ${resAsset.data.elements[0].name}`;
        const directory = path.join('.', _cid, 'Week ' + padZero(weekNum), padZero(moduleNum) + ' - ' + module.name);
        const downloader = new Downloader({ url, directory, fileName, cloneFiles: false, timeout: 300000 });
        await downloader.download();
        log(`      ${chalk.white('Asset')} ${chalk.green(`#${padZero(assetNum)} - Saved '${fileName}'`)}`);
    }

    /**
     * Downloads the highest resolution (720p mp4) lecture video file for the given video object.
     * @param {int} videoNum The numerical sequence of the video (i.e. 01, 02, 03, ...)
     * @param {object} video The video object extracted from the response of `onDemandLectureVideos.v1` API
     * @param {int} moduleNum The numerical sequence of the module (i.e. 01, 02, 03, ...)
     * @param {object} module The week object extracted from the course details
     * @param {int} weekNum The numerical sequence of the week (i.e. 01, 02, 03, ...)
     * @param {object} week The week object extracted from the course details
     */
    async function scrapeVideo(videoNum, video, moduleNum, module, weekNum, week) {
        log(
            `      ${chalk.white('Video')} ${chalk.yellow(
                `#${padZero(videoNum)} - ` + `Downloading 720p lecture video`
            )}`
        );

        const url = video.sources.byResolution['720p'].mp4VideoUrl;
        const fileName = `${padZero(videoNum)} - Lecture video (720p).mp4`;
        const directory = path.join('.', _cid, 'Week ' + padZero(weekNum), padZero(moduleNum) + ' - ' + module.name);
        const downloader = new Downloader({ url, directory, fileName, cloneFiles: false, timeout: 300000 });
        await downloader.download().catch((err) => {
            throw err + '\nUnable to download video.\n';
        });
        log(`      ${chalk.white('Video')} ${chalk.green(`#${padZero(videoNum)} - Saved '${fileName}'`)}`);
    }

    /**
     * Scrapes the given module by looping over each of its assets and videos. The function creates a pool
     * of promises to fetch all the assets and videos concurrently.
     * Assets are fetched via `onDemandLectureAssets.v1` API and downloaded via `scrapeAsset()`
     * Videos are fetched via `onDemandLectureVideos.v1` and downloaded via `scrapeVideo()`
     * @param {int} moduleNum The numerical sequence of the module (i.e. 01, 02, 03, ...)
     * @param {object} module The week object extracted from the course details
     * @param {int} weekNum The numerical sequence of the week (i.e. 01, 02, 03, ...)
     * @param {object} week The week object extracted from the course details
     */
    async function scrapeModule(moduleNum, module, weekNum, week) {
        log(`\n    ${chalk.white('Module')} ${chalk.yellow(`#${padZero(moduleNum)} - ${module.name}`)}`);

        const lectureAssets = axios
            .get(
                `https://www.coursera.org/api/onDemandLectureAssets.v1/${_courseDetails.courseId}~${module.id}/?includes=openCourseAssets`,
                { headers: { Cookie: `CAUTH=${_cauth}` } }
            )
            .catch((err) => {
                if (
                    err &&
                    err.response &&
                    err.response.data &&
                    err.response.data.message &&
                    err.response.data.message.startsWith('Wrong content type for item StoredItem')
                ) {
                    console.log('      Module does not have any downloadable assets.');
                } else throw err + '\nUnable to fetch lecture assets.\n';
            });
        const lectureVideos = axios
            .get(
                `https://www.coursera.org/api/onDemandLectureVideos.v1/${_courseDetails.courseId}~${module.id}?includes=video&fields=onDemandVideos.v1(sources%2Csubtitles%2CsubtitlesVtt%2CsubtitlesTxt)`,
                { headers: { Cookie: `CAUTH=${_cauth}` } }
            )
            .catch((err) => {
                if (
                    err &&
                    err.response &&
                    err.response.data &&
                    err.response.data.message &&
                    err.response.data.message.startsWith('Wrong content type for item StoredItem')
                ) {
                    console.log('      Module does not have any downloadable videos.');
                } else throw err + '\nUnable to fetch lecture video.\n';
            });
        const resModule = await Promise.all([lectureAssets, lectureVideos]);
        let assetNum = 0;
        const promises = [];
        // resModule[1] has the videos
        if (resModule[1]) {
            const video = resModule[1].data.linked['onDemandVideos.v1'][0];
            assetNum += 1;
            promises.push(scrapeVideo(assetNum, video, moduleNum, module, weekNum, week));
        }
        // resModule[0] has the assets
        if (resModule[0]) {
            for (const asset of resModule[0].data.linked['openCourseAssets.v1']) {
                assetNum += 1;
                promises.push(scrapeAsset(assetNum, asset, moduleNum, module, weekNum, week));
            }
        }
        await Promise.all(promises);
        // return resModule;
    }

    /**
     * Scrapes the given week by looping over each of its modules and calling `scrapeModule()`
     * @param {int} weekNum The numerical sequence of the week (i.e. 01, 02, 03, ...)
     * @param {object} week The week object extracted from the course details
     */
    async function scrapeWeek(weekNum, week) {
        log(`\n  ${chalk.white('Week')} ${chalk.yellow(`#${padZero(weekNum)}`)}`);

        let moduleNum = 0;
        for (const module of week.modules[0].items) {
            moduleNum += 1;
            await scrapeModule(moduleNum, module, weekNum, week);
        }
    }

    /**
     * Scrapes the course by looping over each week in the course details and calling `scrapeWeek()`
     */
    async function scrapeCourse() {
        log(`\n${chalk.white('Course')} '${chalk.yellow(_cid)}'`);

        let weekNum = 0;
        for (const week of _courseDetails.weeks) {
            weekNum += 1;
            await scrapeWeek(weekNum, week);
        }
    }

    /**
     * Main app logic:
     * 1) Get the course ID and CAUTH value by prompting the user
     * 2) Authenticate and fet the user ID via `adminUserPermissions.v1` API
     * 3) Get the course details via `guidedCourseWeekCards.v1` API
     * 4) Scrape the course and download & save all course assets & videos
     *
     * All assets and videos are saved in a hierarhical directory structure as follows:
     * <course id>/<## - week id>/<## - module id>/<## - asset / video>
     *
     * For example, for the `neural-networks-deep-learning` course, this looks like this:
     *
     * neural-networks-deep-learning
     *      Week 01
     *          1 - Welcome
     *              01 - Lecture video (720p).mp4
     *              02 - Welcome_merged.doc
     *              03 - 3287059-Welcome-extended-description-mixed (1).mp4
     *          2 - What is a Neural Network?
     *              01 - Lecture video (720p).mp4
     *              02 - What is a NN?.pptx
     *              03 - What_is_Neural_Network.pdf
     *              ...
     */
    async function main() {
        log(chalk.yellow(figlet.textSync('cscraper', { font: 'Standard', horizontalLayout: 'full' })));
        log();
        try {
            await getCourseAndCauth();
            await getUserId();
            await getCourseDetails();
            await scrapeCourse();
        } catch (error) {
            log(chalk.red(error));
        }
    }

    return api;
})();

app.main();
