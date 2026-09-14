import test from "node:test";
import assert from "node:assert/strict";
import {
  basename,
  detectLanguage,
  extensionOf,
  languageLabel,
  shebangLanguage,
} from "../src/ui/editorLanguage.js";

test("path helpers handle posix and windows style paths", () => {
  assert.equal(basename("/srv/app/config.json"), "config.json");
  assert.equal(basename("/etc/nginx/"), "nginx");
  assert.equal(basename("C:\\nginx\\nginx.conf"), "nginx.conf");
  assert.equal(basename(""), "");
  assert.equal(extensionOf(".env"), "env");
  assert.equal(extensionOf(".env.local"), "local");
  assert.equal(extensionOf("Dockerfile"), "");
  assert.equal(extensionOf("app.tar.gz"), "gz");
});

test("shebang lines map to an interpreter", () => {
  assert.equal(shebangLanguage("#!/bin/bash\nset -e\n"), "Shell");
  assert.equal(shebangLanguage("#!/usr/bin/env python3 -u\nprint(1)\n"), "Python");
  assert.equal(shebangLanguage("#!/usr/bin/env -S deno run\n"), "JavaScript");
  assert.equal(shebangLanguage("#!/usr/bin/env FOO=1 bash\n"), "Shell");
  assert.equal(shebangLanguage("#!/usr/bin/perl\n"), "Perl");
  assert.equal(shebangLanguage("# not a shebang\n"), null);
  assert.equal(shebangLanguage("#!/usr/bin/made-up-tool\n"), null);
});

test("file editor picks a language for server configuration files", () => {
  const cases = [
    ["/srv/app/config.json", "", "JSON"],
    ["/srv/app/server.ts", "", "TypeScript"],
    ["/srv/app/index.mts", "", "TypeScript"],
    ["/srv/app/main.go", "", "Go"],
    ["/srv/app/app.py", "", "Python"],
    ["/srv/app/index.php", "", "PHP"],
    ["/srv/app/deploy.sh", "", "Shell"],
    ["/root/.bashrc", "", "Shell"],
    ["/root/.zshrc", "", "Shell"],
    ["/srv/app/.env", "", "Properties files"],
    ["/srv/app/.env.local", "", "Properties files"],
    ["/srv/app/app.conf", "", "Properties files"],
    ["/srv/app/app.ini", "", "Properties files"],
    ["/etc/systemd/system/api.service", "", "Properties files"],
    ["/etc/nginx/nginx.conf", "", "Nginx"],
    ["/etc/nginx/sites-enabled/example.vhost", "", "Nginx"],
    ["/opt/api/Dockerfile", "", "Dockerfile"],
    ["/opt/api/Dockerfile.dev", "", "Dockerfile"],
    ["/opt/api/build.dockerfile", "", "Dockerfile"],
    ["/srv/app/docker-compose.yml", "", "YAML"],
    ["/srv/app/values.yaml", "", "YAML"],
    ["/srv/app/tsconfig.jsonc", "", "JSON"],
    ["/srv/app/README.md", "", "Markdown"],
    ["/usr/local/bin/deploy", "#!/usr/bin/env python3\n", "Python"],
    ["/usr/local/bin/start", "#!/bin/sh\n", "Shell"],
  ];
  for (const [path, content, expected] of cases) {
    assert.equal(languageLabel(path, content), expected, `${path} -> ${expected}`);
    const description = detectLanguage(path, content);
    assert.ok(description, `${path} should resolve a language`);
    assert.equal(typeof description.load, "function");
  }
});

test("unknown and plain files fall back to plain text", () => {
  assert.equal(languageLabel("/srv/app/settings"), null);
  assert.equal(languageLabel("/srv/app/notes.txt"), null);
  assert.equal(languageLabel("/srv/app/binary.dat"), null);
  assert.equal(languageLabel("/srv/app/app"), null);
  assert.equal(languageLabel(""), null);
  assert.equal(languageLabel("/srv/app/keys/server.pem"), null);
});
