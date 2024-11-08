// Function to execute a shell, node, or file writing command and stream outputs
async function executeTask(task, workingDirectory) {
  if (!task.command) {
    // No command to execute
    return { stdout: "", stderr: "" };
  }

  console.log(`\nExecuting Task ID ${task.id}: ${task.description}`);
  console.log(`Command: ${task.command}`);

  if (task.type === "write_file") {
    // Handle file writing via Node.js's fs module (overwrite)
    try {
      const [filename, ...contentLines] = task.command.split("|");
      const filePath = path.join(workingDirectory, filename.trim());

      // Check if the file has already been created
      if (createdFiles.has(filePath)) {
        console.warn(
          `File ${filePath} already exists. Skipping write_file command to prevent overwriting.`
        );
        return {
          stdout: `Skipped writing to ${filePath} to prevent overwriting.`,
          stderr: "",
        };
      }

      const content = contentLines.join("\n");
      await writeFileAsync(filePath, content, { encoding: "utf8" });
      console.log(`File written successfully to ${filePath}`);
      createdFiles.add(filePath); // Mark the file as created
      return { stdout: `File written to ${filePath}`, stderr: "" };
    } catch (error) {
      console.error(`Error writing file: ${error.message}`);
      return { stdout: `File write failed: ${error.message}`, stderr: "" };
    }
  } else if (task.type === "append_file") {
    // Handle appending to a file via Node.js's fs module
    try {
      const [filename, ...contentLines] = task.command.split("|");
      const filePath = path.join(workingDirectory, filename.trim());

      // Check if the file exists before appending
      try {
        await accessAsync(filePath, fs.constants.F_OK);
      } catch (err) {
        console.warn(`File ${filePath} does not exist. Creating it now.`);
        createdFiles.add(filePath); // Mark the file as created
      }

      const content = contentLines.join("\n");
      await appendFileAsync(filePath, content + "\n", { encoding: "utf8" });
      console.log(`Content appended successfully to ${filePath}`);
      return { stdout: `Content appended to ${filePath}`, stderr: "" };
    } catch (error) {
      console.error(`Error appending to file: ${error.message}`);
      return { stdout: `File append failed: ${error.message}`, stderr: "" };
    }
  } else {
    // Handle shell and node commands
    let cmd;
    let args = [];
    let options = { cwd: workingDirectory, shell: true };

    if (task.type === "node") {
      cmd = "node";
      args = [task.command];
    } else {
      // Default to shell command
      cmd = task.command;
    }

    return new Promise((resolve, reject) => {
      let child;
      if (task.type === "node") {
        child = spawn(cmd, args, options);
      } else {
        child = spawn(cmd, { ...options, stdio: "pipe" });
      }

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        process.stdout.write(data);
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        process.stderr.write(data);
        stderr += data.toString();
        stdout += data.toString();
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          stdout += `Command exited with code ${code}: ${stderr}`;
          resolve({ stdout, stderr });
        }
      });

      child.on("error", (err) => {
        stdout += `${err}`;
        resolve({ stdout, stderr });
      });
    });
  }
}

// Function to get the content of code files for context
async function getCodeFilesContent(workingDirectory) {
  const codeFiles = [];
  for (const filePath of createdFiles) {
    try {
      const content = await readFileAsync(filePath, "utf8");
      codeFiles.push(
        `File: ${path.relative(workingDirectory, filePath)}\n---\n${content}`
      );
    } catch (err) {
      console.error(`Error reading file ${filePath}:`, err);
    }
  }
  return codeFiles;
}
