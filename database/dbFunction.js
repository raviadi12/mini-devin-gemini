// Function to save session memory to SQLite
function saveSessionMemory(role, message) {
  db.run(
    `INSERT INTO session_memory (role, message) VALUES (?, ?)`,
    [role, message],
    (err) => {
      if (err) {
        console.error("Error saving to session memory:", err);
      }
    }
  );
}

// Function to parse tasks from the LLM response and store them in the database
function parseTasksFromResponse(responseText) {
  const tasks = [];
  const lines = responseText.split("\n").filter((line) => line.trim() !== "");

  // Limit to one task per response to prevent task flooding
  const firstTaskLine = lines.find((line) => line.includes("$execute_command"));
  if (!firstTaskLine) {
    console.warn("No valid task found in AI response.");
    return tasks;
  }

  // Expected format: [optional number]. [Task Description] [$execute_command("command")] [$command_type("type")]
  // Example: 1. Initialize a new React app [$execute_command("npx create-react-app frontend")] [$command_type("shell")]

  const commandMatch = firstTaskLine.match(/\$execute_command\("(.+?)"\)/);
  const typeMatch = firstTaskLine.match(/\$command_type\("(.+?)"\)/);
  const descriptionMatch = firstTaskLine.match(
    /^(?:\d+\.\s)?(.+?)(?:\s*\$execute_command\(".*?"\))?(?:\s*\$command_type\(".*?"\))?$/
  );

  const taskDescription = descriptionMatch
    ? descriptionMatch[1].trim()
    : firstTaskLine.trim();
  const command = commandMatch ? commandMatch[1] : null;
  const type = typeMatch ? typeMatch[1].toLowerCase() : "shell"; // Default to 'shell' if not specified

  // Skip tasks with empty commands to prevent overwriting files unintentionally
  if (
    (type === "write_file" || type === "append_file") &&
    (!command || command.trim() === "")
  ) {
    console.warn(`Skipped task "${taskDescription}" due to empty command.`);
    return tasks;
  }

  // Avoid duplicating tasks by checking if the task already exists
  tasks.push({
    description: taskDescription,
    command: command,
    type: type,
    status: "pending",
    output: "",
    error: "",
    retries: 0,
  });

  // Insert task into SQLite database
  db.run(
    `INSERT INTO tasks (description, command, type) VALUES (?, ?, ?)`,
    [taskDescription, command, type],
    function (err) {
      if (err) {
        console.error("Error saving task to database:", err);
      } else {
        console.log(`Task saved with ID: ${this.lastID}`);
      }
    }
  );

  return tasks;
}
