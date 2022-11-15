#!/usr/bin/env node

import chalk from "chalk";
import { program } from "commander";
import { execa } from "execa";
import fs from "fs-extra";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pRetry from "p-retry";
import { downloadDirectory } from "./utils/download.js";
import { parseGitHubUrl, GitHubLocation } from "./utils/parse.js";

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
  const location = parseGitHubUrl(program.args[0]);

  console.log();
  console.log(
    `🔗 ${location.user}/${location.repository} (${chalk.green(
      location.branch
    )})`
  );
  console.log(`📂 ${location.dir}`);

  temporaryDirectoryName = await pRetry(createTemporaryDirectory, {
    retries: 3,
    minTimeout: 0,
    maxTimeout: 0,
  });

  await downloadDirectory(location, temporaryDirectoryName);

  const finalDirectoryName = await renameDirectory(
    location,
    temporaryDirectoryName
  );

  if (init) {
    await initializeGit(finalDirectoryName);
  }

  console.log();
  console.log(chalk.green("✅ done"));
  console.log(
    `👉 use ${chalk.cyan(`cd ${finalDirectoryName}`)} to enter the directory`
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

async function renameDirectory(
  location: GitHubLocation,
  directoryName: string
) {
  let bestName = location.repository + "-" + location.dir.replace(/\//g, "-");

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
