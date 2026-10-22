import fs from "node:fs";
import crypto from "node:crypto";
const plugins = ["src/discord-cleaner.js", "src/invisible-typing.js", "src/message-logger.js"].map(
  (file) => {
    const source = fs.readFileSync(file, "utf8");
    const field = (name) => source.match(new RegExp(`^// @${name} (.+)$`, "m"))?.[1].trim();
    for (const name of ["name", "version", "author"])
      if (!field(name)) throw Error(`${file}: missing ${name}`);
    return {
      id: file.split("/").pop().slice(0, -3),
      name: field("name"),
      version: field("version"),
      author: field("author"),
      description: field("description") || "",
      file,
      minimumRuntime: "0.0.1",
      sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    };
  },
);
fs.writeFileSync(
  "catalog.json",
  JSON.stringify({ format: 1, project: "Nitracord", plugins }, null, 2) + "\n",
);
