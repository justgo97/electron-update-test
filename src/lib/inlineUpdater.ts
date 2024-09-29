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
   * @param {Boolean} notifyBeforeApply Defaults to `true`.  When enabled the user will be
   *                             prompted to apply the update immediately after download.
   */
  readonly notifyBeforeApply?: boolean;

  /**
   * @param {Boolean} notifyBeforeDownload Defaults to `true`.  When enabled the user will be
   *                             prompted to whether start downloading the update or not.
   */
  readonly notifyBeforeDownload?: boolean;
}

//const supportedPlatforms = ["darwin", "win32"];
const supportedPlatforms = ["win32"];

class InlineUpdaterClass {
  hasLatestVersion = true;
  fetchedVersion: string = "0.0.0";
  updateInterval: string;
  notifyBeforeApply: boolean;
  notifyBeforeDownload: boolean;
  pauseUpdates: boolean;
  private downloadUrl: string;
  private user: string;
  private repo: string;

  setup(opts?: IUpdateElectronAppOptions) {
    const electronApp = electron.app;

    if (electronApp.isReady()) this.onAppReady(opts);
    else electronApp.on("ready", () => this.onAppReady(opts));

    return true;
  }

  private async onAppReady(opts?: IUpdateElectronAppOptions) {
    const electronApp = electron.app;

    // check for bad input early, so it will be logged during development
    this.validateInput(opts, electronApp);

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

    await this.checkVersionDelta();

    if (this.notifyBeforeDownload) {
      this.promptDownload();
    } else {
      this.initUpdater();
    }
  }

  private async checkVersionDelta() {
    const electronApp = electron.app;

    this.downloadUrl = await this.fetchDownloadUrl();

    if (!this.downloadUrl) {
      return false;
    }

    this.hasLatestVersion = semver.gte(
      electronApp.getVersion(),
      this.fetchedVersion
    );

    if (this.hasLatestVersion) {
      console.log(`App has the lastest version(${this.fetchedVersion})`);
      return true;
    }
  }

  private validateInput(
    opts: IUpdateElectronAppOptions,
    electronApp: typeof Electron.app
  ) {
    const pgkRepo = this.guessRepo(electronApp.getAppPath());

    this.repo = opts?.repo || pgkRepo.repo;
    this.user = opts?.user || pgkRepo.user;

    this.updateInterval = opts?.updateInterval || "10 minutes";

    this.notifyBeforeApply = opts?.notifyBeforeApply || false;

    assert(this.repo, "repo is required");

    assert(
      typeof this.updateInterval === "string" &&
        this.updateInterval.match(/^\d+/),
      "updateInterval must be a human-friendly string interval like `20 minutes`"
    );

    assert(
      ms(this.updateInterval) >= 5 * 60 * 1000,
      "updateInterval must be `5 minutes` or more"
    );
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

  private async fetchDownloadUrl() {
    const apiUrl = `https://api.github.com/repos/${this.user}/${this.repo}/releases?per_page=100`;
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
          console.log("release.tag_name: ", release.tag_name);
          return `https://github.com/${this.user}/${this.repo}/releases/download/${release.tag_name}/RELEASES`;
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

  private promptDownload() {
    const dialogOpts: MessageBoxOptions = {
      type: "info",
      buttons: ["Yes", "Later"],
      title: "Application Update",
      message: this.fetchedVersion,
      detail:
        "A new version can be downloaded. Would you like to start downloading in background?",
    };

    dialog.showMessageBox(dialogOpts).then(({ response }) => {
      if (response === 0) {
        this.initUpdater();
      } else {
        this.pauseUpdates = true;
      }
    });
  }

  private initUpdater() {
    const electronUpdater = electron.autoUpdater;
    console.log("UpdateUrl: ", this.downloadUrl);

    electronUpdater.setFeedURL({ url: this.downloadUrl });

    if (this.pauseUpdates) return;

    if (this.hasLatestVersion) {
      return;
    }

    electronUpdater.checkForUpdates();
    setInterval(() => {
      if (this.pauseUpdates) return;

      if (this.hasLatestVersion) {
        this.checkVersionDelta();
        return;
      }

      electronUpdater.checkForUpdates();
    }, ms(this.updateInterval));

    if (this.notifyBeforeApply) {
      electronUpdater.on("update-downloaded", this.onUpdateDownloaded);
    }

    return true;
  }

  private onUpdateDownloaded = (
    event: Electron.Event,
    releaseNotes: string,
    releaseName: string,
    releaseDate: Date,
    updateURL: string
  ) => {
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
      if (response === 0) electron.autoUpdater.quitAndInstall();
    });
  };
}

const inlineUpdater = new InlineUpdaterClass();

export { inlineUpdater };
