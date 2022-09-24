#!/usr/bin/env node

import chalk from "chalk";
import { program } from "commander";
import fs from "fs-extra";
import got from "got";
import PQueue from "p-queue";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { SingleBar, Presets } from "cli-progress";
import pRetry from "p-retry";
import { execa } from "execa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const packageJson = fs.readJSONSync(path.join(__dirname, "../package.json"));

program
  .version(packageJson.version)
  .description(packageJson.description)
  .argument("<url>", "the repository (subfolder / tree) to download from")
  .option("-i, --init", "Initialize folder as a new git repository")
  .parse(process.argv);

const { init } = program.opts<{ init: boolean }>();

let temporaryFolderName: string | undefined;

try {
  const parsedGitHubUrl = parseGitHubUrl(program.args[0]);

  temporaryFolderName = await pRetry(createTemporaryFolder, {
    retries: 3,
  });

  await downloadFolder(parsedGitHubUrl, temporaryFolderName);

  const finalFolderName = await renameFolder(
    parsedGitHubUrl,
    temporaryFolderName
  );

  if (init) {
    await initializeGit(finalFolderName);
  }

  console.log();
  console.log(chalk.green("✅ Done!"));
  console.log(
    `👉 Run ${chalk.blue.dim(`cd ${finalFolderName}`)} to enter the folder`
  );
} catch (error) {
  console.warn(chalk.red("😱 Something went wrong!"));

  if (temporaryFolderName) {
    await fs.remove(temporaryFolderName);
  }

  console.error((error as Error)?.message);
  process.exit(1);
}

async function initializeGit(folderName: string) {
  await fs.remove(path.join(folderName, ".git"));

  await execa("git", ["init", "--initial-branch=main"], {
    cwd: folderName,
  });

  await execa("git", ["add", "--all"], {
    cwd: folderName,
  });

  await execa("git", ["commit", '-m "initial commit"'], {
    cwd: folderName,
  });

  console.log();
  console.log(chalk.green("🚀 Initialized git repository"));
}

async function createTemporaryFolder() {
  const folderName = crypto.randomUUID();
  await fs.mkdir(folderName);
  return folderName;
}

interface GitHubFile {
  name: string;
  path: string;
  sha: string;
  size: number;
  url: string;
  html_url: string;
  git_url: string;
  download_url: string;
  type: string;
  _links: {
    self: string;
    git: string;
    html: string;
  };
  transferredSize?: number;
}

async function downloadFolder(
  parsedGitHubUrl: ReturnType<typeof parseGitHubUrl>,
  folderName: string
) {
  console.log(`📥 ${chalk.green("Downloading files...")}`);

  const queue = new PQueue({ concurrency: 8 });

  const { author, repository, branch, dir } = parsedGitHubUrl;

  const githubApiUrl = `https://api.github.com/repos/${author}/${repository}/contents/${dir}?ref=${branch}`;

  const filesAndFolders = await got(githubApiUrl).json<GitHubFile[]>();

  const filesToDownload = filesAndFolders.filter(
    (file) => file.download_url && file.size > 0
  );

  const sizeAll = filesToDownload.reduce((sum, file) => sum + file.size, 0);

  const progressBar = new SingleBar(
    {
      format: `{bar}${chalk.dim(" ┈ ")}{percentage}%${chalk.dim(
        " ┈ {value}/{total} bytes transferred"
      )}`,
    },
    Presets.shades_classic
  );

  progressBar.start(sizeAll, 0);

  function handleDownloadProgress() {
    progressBar.update(
      filesToDownload.reduce(
        (sum, file) => sum + (file.transferredSize ?? 0),
        0
      )
    );
  }

  await queue.addAll(
    filesToDownload.map((file, index) => {
      return async () => {
        const { download_url, path: fullFilePath } = file;

        await fs.mkdirp(folderName);

        const filePath = path.join(folderName, fullFilePath.replace(dir, "."));

        const downloadStream = got.stream.get(download_url);
        const writeStream = fs.createWriteStream(filePath, { flags: "w" });

        downloadStream.on("downloadProgress", (progress) => {
          filesToDownload[index].transferredSize = progress.transferred;
          handleDownloadProgress();
        });

        await pipeline(downloadStream, writeStream);
      };
    })
  );

  progressBar.stop();
  console.log();
}

async function renameFolder(
  parsedGitHubUrl: ReturnType<typeof parseGitHubUrl>,
  folderName: string
) {
  let bestName =
    parsedGitHubUrl.repository + "-" + parsedGitHubUrl.dir.replace(/\//g, "-");

  try {
    const packageJson = await fs.readJSON(
      path.join(folderName, "package.json")
    );
    if (packageJson.name) {
      bestName = packageJson.name;
    }
  } catch {
    // this is not a node project so we can't use the package.json name
  }

  let retries = 0;
  async function renameFolder() {
    const currentName = `${bestName}${retries ? "-" + retries : ""}`;

    if (await fs.pathExists(currentName)) {
      throw new Error("Folder already exists");
    }

    await fs.rename(folderName, currentName);

    return currentName;
  }

  const finalFolderName = await pRetry(renameFolder, {
    forever: true,
    minTimeout: 0,
    maxTimeout: 0,
    onFailedAttempt: () => {
      retries++;
    },
  });

  console.log(
    `📂 ${chalk.green(`Created folder: ${chalk.bold(finalFolderName)}`)}`
  );

  return finalFolderName;
}

function parseGitHubUrl(url: string) {
  if (!url.startsWith("https://github.com/")) {
    url = `https://github.com/${url}`;
  }

  const pathname = new URL(url).pathname.split("/");

  const parsed = {
    author: pathname[1],
    repository: pathname[2],
    branch: pathname[4],
    dir: pathname.slice(5).join("/"),
  };

  if (!parsed.author || !parsed.repository || !parsed.branch || !parsed.dir) {
    throw new Error("Invalid GitHub URL");
  }

  console.log(`
🔗 ${parsed.author}/${parsed.repository} (${chalk.green(parsed.branch)})
📂 ${parsed.dir}
`);

  return parsed;
}
