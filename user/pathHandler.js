//handling directory path
const mkdirAsync = util.promisify(fs.mkdir);
const accessAsync = util.promisify(fs.access);
const path = require("path");

async function directoryPathHandler(absolutePath) {
  absolutePath = path.resolve("./example-test/" + workingDirectory);
  try {
    await accessAsync(absolutePath, fs.constants.F_OK);
    console.log(`Using existing directory at ${absolutePath}`);
  } catch (err) {
    try {
      await mkdirAsync(absolutePath, { recursive: true });
      console.log(`Created new directory at ${absolutePath}`);
    } catch (mkdirErr) {
      console.error(`Error creating directory ${absolutePath}:`, mkdirErr);
      process.exit(1);
    }
  }
}

function dbPathHandler(absolutePath) {
  return path.join(absolutePath, "chatbot.db");
}
