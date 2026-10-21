import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/** The built page requests a hashed stylesheet. Also keep styles.css and themes.css at stable URLs so the shell can precache those names. */
function precacheShell(): Plugin {
  return {
    name: "precache-shell",
    apply: "build",
    closeBundle() {
      mkdirSync("dist/src", { recursive: true });
      cpSync("src/styles.css", "dist/src/styles.css");
      cpSync("src/themes.css", "dist/src/themes.css");
      const html = readFileSync("dist/index.html", "utf8");
      const extra = [...html.matchAll(/\.\/(assets\/[^"]+\.(?:css|js))/g)].map((m) => m[1]);
      const swPath = "dist/sw.js";
      const sw = readFileSync(swPath, "utf8");
      const shell = sw.match(/const SHELL = \[([\s\S]*?)\];/);
      if (!shell) throw new Error("sw.js is missing SHELL");
      const items = [...shell[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      for (const file of extra) if (!items.includes(file)) items.push(file);
      writeFileSync(swPath, sw.replace(shell[0], `const SHELL = [${items.map((i) => `"${i}"`).join(", ")}];`));
    },
  };
}

export default defineConfig({ base: "./", build: { target: "es2022" }, plugins: [precacheShell()] });
