import chalk from "chalk";
import { Presets, SingleBar } from "cli-progress";
import { execa } from "execa";
import fs from "fs-extra";
import got from "got";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import PQueue from "p-queue";
import prettyBytes from "pretty-bytes";
import { GitHubLocation } from "./parse.js";

interface TreeEntry {
  path: string;
  mode: string;
  type: "tree" | "blob";
  sha: string;
  size?: number;
  url: string;
  transferredSize?: number;
}

let GITHUB_TOKEN = process.env.GITHUB_TOKEN;

async function getAuthToken() {
  try {
    const token = await execa("gh", ["auth", "token"]);
    if (token.stdout) {
      GITHUB_TOKEN = token.stdout;
    }
  } catch {
    // Ignore
  }
}

let didLogAuth = false;

async function get<T>(endpoint: string): Promise<T> {
  if (!GITHUB_TOKEN) {
    await getAuthToken();
  }

  if (!didLogAuth) {
    if (GITHUB_TOKEN) {
      console.log(chalk.dim("🔑 using GitHub API with token"));
    } else {
      console.log(chalk.dim("👥 using GitHub API anonymously"));
    }
    didLogAuth = true;
  }

  return got(
    endpoint,
    GITHUB_TOKEN
      ? {
          headers: {
            Authorization: `token ${GITHUB_TOKEN}`,
          },
        }
      : undefined
  ).json<T>();
}

function getDownloadUrl(location: GitHubLocation, path: string) {
  return `https://raw.githubusercontent.com/${location.user}/${location.repository}/${location.branch}/${location.dir}/${path}`;
}

export async function downloadDirectory(
  location: GitHubLocation,
  directoryName: string
) {
  console.log();
  console.log(`📥 ${chalk.green("downloading files...")}`);

  const { user, repository, branch, dir } = location;

  const entry = await get<{ commit: { sha: string } }>(
    `https://api.github.com/repos/${user}/${repository}/branches/${branch}`
  );

  let currentDirectory: TreeEntry = {
    path: "",
    mode: "040000",
    type: "tree",
    sha: entry.commit.sha,
    url: `https://api.github.com/repos/${user}/${repository}/git/trees/${entry.commit.sha}`,
  };

  const directoryStack = dir.split("/");

  while (directoryStack.length > 0) {
    const treeResponse = await get<{
      tree: TreeEntry[];
    }>(currentDirectory.url);

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

  const recursiveTreeResponse = await get<{ tree: TreeEntry[] }>(
    currentDirectory.url + "?recursive=1"
  );

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

        const downloadUrl = getDownloadUrl(location, relativeFilePath);

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
