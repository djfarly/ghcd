export interface GitHubLocation {
  user: string;
  repository: string;
  branch: string;
  dir: string;
}

export function parseGitHubUrl(url: string): GitHubLocation {
  if (!url.startsWith("https://github.com/")) {
    url = `https://github.com/${url}`;
  }

  const pathname = new URL(url).pathname.split("/");

  const parsed = {
    user: pathname[1],
    repository: pathname[2],
    branch: pathname[4],
    dir: pathname.slice(5).join("/"),
  };

  if (!parsed.user || !parsed.repository || !parsed.branch || !parsed.dir) {
    throw new Error("Invalid GitHub URL");
  }

  return parsed;
}
