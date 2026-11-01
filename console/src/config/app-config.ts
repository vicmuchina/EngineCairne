import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "CAIRN",
  version: packageJson.version,
  copyright: `© ${currentYear}, CAIRN.`,
  /** Local actor shown in the shell; Cairn has no accounts or auth. */
  actor: {
    name: "Cairn",
    role: "local actor",
  },
  meta: {
    title: "CAIRN — Project exploration console",
    description: "Console for Cairn projects, findings, intents and conversations",
  },
};
