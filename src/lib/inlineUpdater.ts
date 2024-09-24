import path from "path";
import fs from "fs";
import assert from "assert";
import gh from "github-url-to-object";
import ms from "ms";
import semver from "semver";

import electron, { dialog, MessageBoxOptions } from "electron";

interface IAsset {
  name: string;
  browser_download_url: string;
}

interface IRelease {
  draft: number;
  prerelease: number;
  tag_name: string;
  assets: IAsset[];
}

interface IUpdateElectronAppOptions {
  /**
   * @param {String} user A GitHub user account identifier.
   */
  readonly user?: string;

  /**
   * @param {String} repo A GitHub repository identifier.
   */
  readonly repo?: string;

  /**
   * @param {String} updateInterval How frequently to check for updates. Defaults to `10 minutes`.
   *                                Minimum allowed interval is `5 minutes`.
   */
  readonly updateInterval?: string;

  /**
   * @param {Boolean} notifyUser Defaults to `true`.  When enabled the user will be
   *                             prompted to apply the update immediately after download.
   */
  readonly notifyBeforeApply?: boolean;
}

//const supportedPlatforms = ["darwin", "win32"];
const supportedPlatforms = ["win32"];

class InlineUpdaterClass {
  hasLatestVersion = true;
  fetchedVersion: string = "0.0.0";

  notifyBeforeApply: boolean;

  async setup(opts?: IUpdateElectronAppOptions) {
    const electronApp = electron.app;
    // check for bad input early, so it will be logged during development
    const safeOpts = this.validateInput(opts, electronApp);

    // don't attempt to update during development
    if (!electronApp.isPackaged) {
      const message =
        "electron-inline-updater config looks good; aborting updates since app is in development mode";
      console.log(message);
      return false;
    }

    // exit early on unsupported platforms, e.g. `linux`
    if (!supportedPlatforms.includes(process?.platform)) {
      console.log(`electron-inline-updater only supports windows platform.`);
      return false;
    }

    /*
    const feedURL = `${safeOpts.user}/${safeOpts.repo}/${process.platform}-${
      process.arch
    }/${electronApp.getVersion()}`;
    */

    const downloadUrl = await this.fetchDownloadUrl(
      safeOpts.user,
      safeOpts.repo
    );

    this.hasLatestVersion = semver.lte(
      electronApp.getVersion(),
      this.fetchedVersion
    );

    if (downloadUrl) {
      if (electronApp.isReady())
        this.initUpdater(electron.autoUpdater, downloadUrl);
      else
        electronApp.on("ready", () =>
          this.initUpdater(electron.autoUpdater, downloadUrl)
        );
      return true;
    }

    return false;
  }

  private validateInput(
    opts: IUpdateElectronAppOptions,
    electronApp: typeof Electron.app
  ) {
    const pgkRepo = this.guessRepo(electronApp.getAppPath());

    const repo = opts?.repo || pgkRepo.repo;
    const user = opts?.user || pgkRepo.user;

    const updateInterval = opts?.updateInterval || "10 minutes";

    this.notifyBeforeApply = opts?.notifyBeforeApply || false;

    assert(repo, "repo is required");

    assert(
      typeof updateInterval === "string" && updateInterval.match(/^\d+/),
      "updateInterval must be a human-friendly string interval like `20 minutes`"
    );

    assert(
      ms(updateInterval) >= 5 * 60 * 1000,
      "updateInterval must be `5 minutes` or more"
    );

    return { user, repo, updateInterval };
  }

  private guessRepo(appPath: string) {
    try {
      const pkgBuf = fs.readFileSync(path.join(appPath, "package.json"));

      const pkg = JSON.parse(pkgBuf.toString());
      const repoString = pkg.repository?.url || pkg.repository;
      const repoObject = gh(repoString);
      assert(
        repoObject,
        "repo not found. Add repository string to your app's package.json file"
      );
      return { user: repoObject.user, repo: repoObject.repo };
    } catch {
      return { user: "", repo: "" };
    }
  }

  private async fetchDownloadUrl(user: string, repo: string) {
    const apiUrl = `https://api.github.com/repos/${user}/${repo}/releases?per_page=100`;
    const headers = { Accept: "application/vnd.github.preview" };

    try {
      const response = await fetch(apiUrl, { headers });
      if (!response.ok) {
        throw new Error(
          `GitHub API returned ${response.status}: ${response.statusText}`
        );
      }

      const data = await response.json();

      const releases: IRelease[] = Array.isArray(data) ? data : [data];

      for (const release of releases) {
        // Validity checks
        if (
          !semver.valid(release.tag_name) ||
          release.draft ||
          release.prerelease
        ) {
          continue;
        }

        const nupkgAsset = release.assets.find((asset) =>
          asset.name.endsWith(".nupkg")
        );

        if (nupkgAsset) {
          this.fetchedVersion = release.tag_name;
          return nupkgAsset.browser_download_url;
        }
      }
    } catch (error: any) {
      console.error(
        "Error fetching [apiUrl] ",
        apiUrl,
        " latest release:",
        error.message
      );
      return null; // Explicitly return null on error
    }
  }

  private initUpdater(
    electronUpdater: Electron.AutoUpdater,
    downloadUrl: string
  ) {
    console.log(downloadUrl);

    electronUpdater.setFeedURL({ url: downloadUrl });

    if (this.notifyBeforeApply) {
      electronUpdater.on(
        "update-downloaded",
        (event, releaseNotes, releaseName, releaseDate, updateURL) => {
          console.log("update-downloaded", [
            event,
            releaseNotes,
            releaseName,
            releaseDate,
            updateURL,
          ]);

          const dialogOpts: MessageBoxOptions = {
            type: "info",
            buttons: ["Restart", "Later"],
            title: "Application Update",
            message: process.platform === "win32" ? releaseNotes : releaseName,
            detail:
              "A new version has been downloaded. Restart the application to apply the updates.",
          };

          dialog.showMessageBox(dialogOpts).then(({ response }) => {
            if (response === 0) electronUpdater.quitAndInstall();
          });
        }
      );
    }

    return true;
  }
}

const inlineUpdater = new InlineUpdaterClass();

export { inlineUpdater };
