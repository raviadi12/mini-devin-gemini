// chatbot.js

const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require("@google/generative-ai");
const { spawn } = require("child_process");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const util = require("util");
const readline = require("readline");

// Promisify certain functions for easier async/await usage
const writeFileAsync = util.promisify(fs.writeFile);
const appendFileAsync = util.promisify(fs.appendFile);
const readFileAsync = util.promisify(fs.readFile);
const dotenv = require("dotenv");

// Load environment variables from .env file
dotenv.config();

// Initialize SQLite Database (will be set after getting working directory)
let db;
let dbGetAsync;
let dbCloseAsync;
let absolutePath;

// Track created files to prevent overwriting
const createdFiles = new Set();

// Flag to indicate if a task is currently being processed
let isProcessing = false;

const generationConfig = {
  temperature: 0.7,
  topP: 0.95,
  topK: 40,
  maxOutputTokens: 500, // Adjust as necessary
  responseMimeType: "text/plain",
};

// Initialize session memory
let sessionMemory = [];

// Main function to run the chatbot
async function runBot() {
  try {
    // kelompok 1
    // Step 1: Prompt the user for inputs
    const projectDescription = await promptUser(
      "What would you like to build? "
    );
    if (!projectDescription.trim()) {
      console.error("Project description cannot be empty.");
      process.exit(1);
    }

    const workingDirectory = await promptUser(
      "Enter the working directory path: "
    );
    if (!workingDirectory.trim()) {
      console.error("Working directory path cannot be empty.");
      process.exit(1);
    }
    // 1

    // kelompok 2
    // Step 2: Check if the working directory exists; if not, create it
    pathHandler(absolutePath);

    // Step 3: Initialize the SQLite database in the working directory
    const dbPath = dbPathHandler(absolutePath);
    initializeDatabase(dbPath);
    // 2

    // kelompok 3
    // Step 4: Initialize the Generative AI model
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("Error: GEMINI_API_KEY environment variable is not set.");
      process.exit(1);
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-002",
      systemInstruction: `
              You are an AI assistant that helps create software step-by-step, manages tasks, and executes commands as needed.
              When creating tasks, provide them in the following format:
              [optional number]. [Task Description] [$execute_command("command")] [$command_type("type")]
              - $execute_command is used to specify the command to execute.
              - $command_type specifies the type of command: "shell", "node", "write_file", or "append_file".
              - For 'write_file' type, the command should be in the format "filename|line1|line2|...|lineN".
              - For 'append_file' type, the command should be in the format "filename|line1|line2|...|lineN".
              - Generate only one task per response.
              - When an error occurs, you will be provided with the current code. Analyze it, identify the issue, and provide a corrected task.
              - Avoid using interactive inputs like input().
              - Use command-line arguments (sys.argv) for user inputs instead.
              - Ensure that all commands are compatible with Windows operating systems.
              - Do not generate tasks that overwrite existing files unless it's the initial creation.
              Example:
              1. Create the main Python file [$execute_command("fibonacci.py|import sys")] [$command_type("write_file")]
              2. Get the number of Fibonacci numbers to generate from command-line arguments [$execute_command("fibonacci.py|try:|    num_terms = int(sys.argv[1])|except IndexError:|    print('Usage: python fibonacci.py <number_of_terms>')|    sys.exit(1)|except ValueError:|    print('Invalid input. Please enter an integer.')|    sys.exit(1)")] [$command_type("append_file")]
              3. Define an iterative Fibonacci function [$execute_command("fibonacci.py|def fibonacci_iterative(n):|    if n <= 0:|        return []|    elif n == 1:|        return [0]|    else:|        list_fib = [0, 1]|        while len(list_fib) < n:|            next_fib = list_fib[-1] + list_fib[-2]|            list_fib.append(next_fib)|        return list_fib")] [$command_type("append_file")]
              4. Run the Python script with a test input [$execute_command("python fibonacci.py 10")] [$command_type("shell")]
            `,
    });

    // Step 5: Plan the project based on user input
    const initialMessage = `User wants to: "${projectDescription}". Analyze the task and create a detailed plan with steps, required libraries, and commands to execute. Use the specified format for tasks. Generate only one task per response.`;
    const initialPlan = await sendMessageToModel(model, "user", initialMessage);
    // 3

    // Step 6: Parse and store initial tasks
    parseTasksFromResponse(initialPlan);

    // Step 7: Start processing tasks sequentially
    while (true) {
      const taskProcessed = await processSingleTask(model, absolutePath);
      if (!taskProcessed) {
        // No task was processed or an error occurred that prevents further processing
        break;
      }
    }

    // Step 8: Final check for any remaining tasks
    const row = await dbGetAsync(
      `SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'in_progress')`
    );

    if (row.count > 0) {
      console.log(
        `\nThere are still ${row.count} task(s) remaining. Continuing task processing...`
      );
      // Continue processing remaining tasks
      while (true) {
        const taskProcessed = await processSingleTask(model, absolutePath);
        if (!taskProcessed) {
          // No more tasks to process
          break;
        }
      }
    } else {
      console.log("\nAll tasks have been processed!");
    }

    // Optional: Close the database connection gracefully
    try {
      await dbCloseAsync();
      console.log("Database connection closed.");
    } catch (closeErr) {
      console.error("Error closing the database connection:", closeErr);
    }
  } catch (error) {
    console.error("An unexpected error occurred:", error);
    if (db) {
      try {
        await dbCloseAsync();
        console.log("Database connection closed.");
      } catch (closeErr) {
        console.error("Error closing the database connection:", closeErr);
      }
    }
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nGracefully shutting down...");
  if (db) {
    try {
      await dbCloseAsync();
      console.log("Database connection closed.");
    } catch (err) {
      console.error("Error closing the database connection:", err);
    }
  }
  process.exit(0);
});

// Run the chatbot
runBot();
