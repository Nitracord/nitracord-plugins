for (const name of ["discord-cleaner", "invisible-typing", "message-logger", "examples"])
  await import(`./${name}.test.mjs`);
