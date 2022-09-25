#!/usr/bin/env node

import chalk from "chalk";
import { Presets, SingleBar } from "cli-progress";
import { program } from "commander";
import { execa } from "execa";
import fs from "fs-extra";
import got from "got";
import crypto from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import PQueue from "p-queue";
import pRetry from "p-retry";
import prettyBytes from "pretty-bytes";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const packageJson = fs.readJSONSync(path.join(__dirname, "../package.json"));

program
  .version(packageJson.version)
  .description(packageJson.description)
  .argument("<url>", "the repository (subdirectory / tree) to download from")
  .option("-i, --init", "Initialize directory as a new git repository")
  .parse(process.argv);

const { init } = program.opts<{ init: boolean }>();

let temporaryDirectoryName: string | undefined;

try {
  const parsedGitHubUrl = parseGitHubUrl(program.args[0]);

  temporaryDirectoryName = await pRetry(createTemporaryDirectory, {
    retries: 3,
    minTimeout: 0,
    maxTimeout: 0,
  });

  await downloadDirectory(parsedGitHubUrl, temporaryDirectoryName);

  const finalDirectoryName = await renameDirectory(
    parsedGitHubUrl,
    temporaryDirectoryName
  );

  if (init) {
    await initializeGit(finalDirectoryName);
  }

  console.log();
  console.log(chalk.green("✅ done"));
  console.log(
    `👉 use ${chalk.blue(`cd ${finalDirectoryName}`)} to enter the directory`
  );
  console.log();
} catch (error) {
  console.warn(chalk.red("😱 something went wrong!"));

  if (temporaryDirectoryName) {
    await fs.remove(temporaryDirectoryName);
  }

  console.error((error as Error).message);
  process.exit(1);
}

async function initializeGit(directoryName: string) {
  await fs.remove(path.join(directoryName, ".git"));

  await execa("git", ["init", "--initial-branch=main"], {
    cwd: directoryName,
  });

  await execa("git", ["add", "--all"], {
    cwd: directoryName,
  });

  await execa("git", ["commit", '-m "initial commit"'], {
    cwd: directoryName,
  });

  console.log();
  console.log(chalk.green("🚀 initialized git repository"));
}

async function createTemporaryDirectory() {
  const directoryName = crypto.randomUUID();
  await fs.mkdir(directoryName);
  return directoryName;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: "tree" | "blob";
  sha: string;
  size?: number;
  url: string;
  transferredSize?: number;
}

function getDownloadUrl(
  parsedGitHubUrl: ReturnType<typeof parseGitHubUrl>,
  path: string
) {
  return `https://raw.githubusercontent.com/${parsedGitHubUrl.author}/${parsedGitHubUrl.repository}/${parsedGitHubUrl.branch}/${parsedGitHubUrl.dir}/${path}`;
}

async function downloadDirectory(
  parsedGitHubUrl: ReturnType<typeof parseGitHubUrl>,
  directoryName: string
) {
  console.log();
  console.log(`📥 ${chalk.green("downloading files...")}`);

  const { author, repository, branch, dir } = parsedGitHubUrl;

  const entry = await got(
    `https://api.github.com/repos/${author}/${repository}/branches/${branch}`
  ).json<{ commit: { sha: string } }>();

  let currentDirectory: TreeEntry = {
    path: "",
    mode: "040000",
    type: "tree",
    sha: entry.commit.sha,
    url: `https://api.github.com/repos/${author}/${repository}/git/trees/${entry.commit.sha}`,
  };

  const directoryStack = dir.split("/");

  while (directoryStack.length > 0) {
    const treeResponse = await got(currentDirectory.url).json<{
      tree: TreeEntry[];
    }>();

    const directoryToMatch = directoryStack.shift();

    const nextDirectory = treeResponse.tree.find(
      (entry) => directoryToMatch === entry.path && entry.type === "tree"
    );

    if (nextDirectory) {
      currentDirectory = nextDirectory;
    } else {
      throw new Error("Could not find directory in tree");
    }
  }

  const recursiveTreeResponse = await got(
    currentDirectory.url + "?recursive=1"
  ).json<{ tree: TreeEntry[] }>();

  const filesToDownload = recursiveTreeResponse.tree.filter(
    (entry) => entry.type === "blob"
  );

  const sizeAll = filesToDownload.reduce(
    (sum, file) => sum + (file.size ?? 0),
    0
  );

  const progressBar = new SingleBar(
    {
      format: `{bar}${chalk.dim(" ┈ ")}{percentage}%${chalk.dim(
        " ┈ {value} of {total} transferred"
      )}`,
      formatValue: (value, _, type) =>
        ["value", "total"].includes(type)
          ? prettyBytes(value)
          : value.toString(),
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

  const queue = new PQueue({ concurrency: 8 });

  await queue.addAll(
    filesToDownload.map((file, index) => {
      return async () => {
        const { path: relativeFilePath } = file;

        const downloadUrl = getDownloadUrl(parsedGitHubUrl, relativeFilePath);

        const filePath = path.join(directoryName, relativeFilePath);

        await fs.ensureDir(path.dirname(filePath));

        const downloadStream = got.stream.get(downloadUrl);
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

async function renameDirectory(
  parsedGitHubUrl: ReturnType<typeof parseGitHubUrl>,
  directoryName: string
) {
  let bestName =
    parsedGitHubUrl.repository + "-" + parsedGitHubUrl.dir.replace(/\//g, "-");

  try {
    const packageJson = await fs.readJSON(
      path.join(directoryName, "package.json")
    );
    if (packageJson.name) {
      bestName = packageJson.name;
    }
  } catch {
    // this is not a node project so we can't use the package.json name
  }

  let retries = 0;
  async function renameDirectory() {
    const currentName = `${bestName}${retries ? "-" + retries : ""}`;

    if (await fs.pathExists(currentName)) {
      throw new Error("Directory already exists");
    }

    await fs.rename(directoryName, currentName);

    return currentName;
  }

  const finalDirectoryName = await pRetry(renameDirectory, {
    forever: true,
    minTimeout: 0,
    maxTimeout: 0,
    onFailedAttempt: () => {
      retries++;
    },
  });

  console.log(`📂 ${chalk.green(`created ${chalk.bold(finalDirectoryName)}`)}`);

  return finalDirectoryName;
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

  console.log();
  console.log(
    `🔗 ${parsed.author}/${parsed.repository} (${chalk.green(parsed.branch)})`
  );
  console.log(`📂 ${parsed.dir}`);

  return parsed;
}
