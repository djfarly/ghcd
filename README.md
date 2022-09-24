# 📂 GitHub Clone Directory — `ghcd`

> A CLI to _clone_[^1] a subdirectory of a GitHub repository

## Usage

Open the subdirectory you want to clone in GitHub, and copy the URL. Then run:

```sh
npx ghcd https://github.com/vercel/next.js/tree/canary/packages/create-next-app
```

This will download `create-next-app` directory of the `vercel/next.js` repository into a new folder.

The `https://github.com/` part is optional, so you can also run:

```sh
npx ghcd vercel/next.js/tree/canary/packages/create-next-app
```

## Options

### `--init` / `-i`

Initialize a new git repository in the downloaded directory.

[^1]: The term _clone_ is used loosely here. 🫣 The CLI does not actually clone the repository, but rather downloads the files into a new folder.
