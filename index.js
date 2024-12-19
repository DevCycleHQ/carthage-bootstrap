// MIT License - Copyright (c) 2020 Stefan Arentz <stefan@devbots.xyz>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.


const fs = require('fs');
const crypto = require('crypto');

const core = require('@actions/core');
const cache = require('@actions/cache');
const execa = require('execa');


/**
 * Generate a unique key for the cache entry. To avoid conflicts with
 * other actions that may store data in the cache, the key is a combination
 * of the following items:
 *
 *  - our tool name
 *  - the repo name
 *  - a hash of Cartfile.resolved and xcodebuild -version
 *
 * This should be enough to invalidate caches when either dependencies
 * or the Xcode version changes.
 */

const generateCacheKey = async () => {
    const resolved = fs.readFileSync("Cartfile.resolved");
    const {stdout} = await execa('xcodebuild', ['-version']);
    const hash = crypto.createHash('sha1').update(resolved+stdout).digest('hex');
    return `devbotsxyz:carthage:${process.env.GITHUB_REPOSITORY}:${hash}`;
};


/**
 * Restore the cache.
 */

const restoreCache = async ({cacheKey}) => {
    const key = cacheKey || await generateCacheKey();
    core.info(`Restoring cache with key ${key}`);
    const result = await cache.restoreCache(["Carthage"], key);
    core.info(`Result of cache.restore is ${result !== undefined}`);
    return result !== undefined;
};


/*
 * Save the cache.
 */

const saveCache = async ({cacheKey}) => {
    try {
        const key = cacheKey || await generateCacheKey();
        core.info(`Saving cache with key ${key}`);
        await cache.saveCache(["Carthage"], key);
        return true;
    } catch (error) {
        core.error(`Carthage could not be cached: ${error.message}`);
        return false;
    }
};


const parseConfiguration = () => {
    const configuration = {
        verbose: core.getInput("verbose") === "true",
        usexcFrameworks: core.getInput("use-xcframeworks") === "true",
        noUseBinaries: core.getInput("no-use-binaries") === "true",
        platform: core.getInput("platform"),
        cache: core.getInput("cache") === "true", // TODO cache=true should be a default
        cacheKey: core.getInput("cache-key"),
        gitHubToken: core.getInput("github-token", {required: true}), // Not required when using SSH?
    };
    return configuration;
};


const carthageBootstrap = async ({platform, noUseBinaries, verbose, gitHubToken, usexcFrameworks}) => {
    let options = [];
    if (platform !== "") {
        options = [...options, "--platform", platform];
    }
    if (verbose) {
        options = [...options, "--verbose"];
    }
    if (noUseBinaries) {
        options = [...options, "--no-use-binaries"];
    }

    if (usexcFrameworks) {
        options = [...options, "--use-xcframeworks"];
    }

    const carthage = execa("carthage", ["bootstrap", ...options],
                           {reject: false, env: {"NSUnbufferedIO": "YES",
                                                 "GITHUB_ACCESS_TOKEN": gitHubToken}});

    carthage.stdout.pipe(process.stdout);
    carthage.stderr.pipe(process.stderr);

    let {exitCode} = await carthage;
    if (exitCode != 0) {
        throw Error(`Carthage bootstrap failed with exit code ${exitCode}`);
    }
};

const main = async () => {
    try {
        const whichResult = await execa('which', ['carthage'], { reject: false });
        if (whichResult.exitCode !== 0 && 
            !fs.existsSync("/usr/local/bin/carthage") && 
            !fs.existsSync("/opt/homebrew/bin/carthage")) {
            core.setFailed(`Cannot find carthage command in PATH or standard locations. which result: ${JSON.stringify(whichResult)}`);
            return;
        }

        if (!fs.existsSync("Cartfile") || !fs.existsSync("Cartfile.resolved")) {
            core.setFailed(`Cannot find Cartfile and Cartfile.resolved in the working directory.`);
            return;
        }

        const configuration = parseConfiguration();

        // If caching is enabled and we have a cached Carthage
        // available for our dependencies then we just restore and be
        // done with it.

        if (configuration.cache) {
            const restored = await restoreCache(configuration);
            if (restored) {
                core.info("Restored Carthage from cache");
                // TODO For clarity print all the dependencies and their versions
                return;    
            }
        }

        // Either no caching was requested or we had not prior build
        // cached, so we run carthage bootstrap as usual.

        await carthageBootstrap(configuration);

        // We just built Carthage from scratch. So if caching was
        // requested then let the post script know that it needs to be
        // saved.

        if (configuration.cache) {
            core.saveState("needsSaveCache", "true");
        }
    } catch (error) {
        core.setFailed(`Carthage bootstrap failed with an unexpected error: ${error.message}`);
    }
};


const post = async () => {
    try {
        const configuration = parseConfiguration();

        // If caching is enabled and we built carthage from scratch,
        // then this is where we cache the Carthage folder.

        if (configuration.cache && core.getState("needsSaveCache") === "true") {
            core.info("Going to save cache");
            const saved = await saveCache(configuration);
            if (saved) {
                core.info("Saved cache");
            }
        }
    } catch (error) {
        core.setFailed(`Caching failed with an unexpected error: ${error.message}`);
    }
};


// TODO It is simpler to have two scripts. Less state and confusion.
if (process.env["STATE_runPost"] === "true") {
    post();
} else {
    core.saveState("runPost", true); // TODO This is a weird hack that is totally confusing.
    main();
}
