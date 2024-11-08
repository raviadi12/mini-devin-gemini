// chatbot.js

const {
    GoogleGenerativeAI,
    HarmCategory,
    HarmBlockThreshold,
} = require("@google/generative-ai");
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const util = require('util');
const readline = require('readline');

// Promisify certain functions for easier async/await usage
const mkdirAsync = util.promisify(fs.mkdir);
const accessAsync = util.promisify(fs.access);
const writeFileAsync = util.promisify(fs.writeFile);
const appendFileAsync = util.promisify(fs.appendFile);
const readFileAsync = util.promisify(fs.readFile);
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();

// Initialize SQLite Database (will be set after getting working directory)
let db;
let dbGetAsync;
let dbCloseAsync;
let absolutePath

// Track created files to prevent overwriting
const createdFiles = new Set();

// Flag to indicate if a task is currently being processed
let isProcessing = false;

const generationConfig = {
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 500,  // Adjust as necessary
    responseMimeType: "text/plain",
};

// Function to initialize the SQLite database
function initializeDatabase(dbPath) {
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error("Could not connect to database", err);
            process.exit(1);
        } else {
            console.log("Connected to SQLite database");
        }
    });

    // Promisify db.get and db.close
    dbGetAsync = util.promisify(db.get).bind(db);
    dbCloseAsync = util.promisify(db.close).bind(db);

    // Set up database tables
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT,
            command TEXT,
            type TEXT CHECK( type IN ('shell','node', 'write_file', 'append_file') ) NOT NULL DEFAULT 'shell',
            status TEXT CHECK( status IN ('pending','in_progress','completed','failed') ) NOT NULL DEFAULT 'pending',
            output TEXT,
            error TEXT,
            retries INTEGER DEFAULT 0
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS session_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT CHECK(role IN ('user','model')),
            message TEXT
        )`);
    });
}

// Function to save session memory to SQLite
function saveSessionMemory(role, message) {
    db.run(`INSERT INTO session_memory (role, message) VALUES (?, ?)`, [role, message], (err) => {
        if (err) {
            console.error("Error saving to session memory:", err);
        }
    });
}

// Function to parse tasks from the LLM response and store them in the database
function parseTasksFromResponse(responseText) {
    const tasks = [];
    const lines = responseText.split('\n').filter(line => line.trim() !== '');

    // Limit to one task per response to prevent task flooding
    const firstTaskLine = lines.find(line => line.includes('$execute_command'));
    if (!firstTaskLine) {
        console.warn("No valid task found in AI response.");
        return tasks;
    }

    // Expected format: [optional number]. [Task Description] [$execute_command("command")] [$command_type("type")]
    // Example: 1. Initialize a new React app [$execute_command("npx create-react-app frontend")] [$command_type("shell")]

    const commandMatch = firstTaskLine.match(/\$execute_command\("(.+?)"\)/);
    const typeMatch = firstTaskLine.match(/\$command_type\("(.+?)"\)/);
    const descriptionMatch = firstTaskLine.match(/^(?:\d+\.\s)?(.+?)(?:\s*\$execute_command\(".*?"\))?(?:\s*\$command_type\(".*?"\))?$/);

    const taskDescription = descriptionMatch ? descriptionMatch[1].trim() : firstTaskLine.trim();
    const command = commandMatch ? commandMatch[1] : null;
    const type = typeMatch ? typeMatch[1].toLowerCase() : 'shell'; // Default to 'shell' if not specified

    // Skip tasks with empty commands to prevent overwriting files unintentionally
    if ((type === 'write_file' || type === 'append_file') && (!command || command.trim() === '')) {
        console.warn(`Skipped task "${taskDescription}" due to empty command.`);
        return tasks;
    }

    // Avoid duplicating tasks by checking if the task already exists
    tasks.push({
        description: taskDescription,
        command: command,
        type: type,
        status: 'pending',
        output: '',
        error: '',
        retries: 0
    });

    // Insert task into SQLite database
    db.run(`INSERT INTO tasks (description, command, type) VALUES (?, ?, ?)`, [taskDescription, command, type], function (err) {
        if (err) {
            console.error("Error saving task to database:", err);
        } else {
            console.log(`Task saved with ID: ${this.lastID}`);
        }
    });

    return tasks;
}

// Function to execute a shell, node, or file writing command and stream outputs
async function executeTask(task, workingDirectory) {
    if (!task.command) {
        // No command to execute
        return { stdout: '', stderr: '' };
    }

    console.log(`\nExecuting Task ID ${task.id}: ${task.description}`);
    console.log(`Command: ${task.command}`);

    if (task.type === 'write_file') {
        // Handle file writing via Node.js's fs module (overwrite)
        try {
            const [filename, ...contentLines] = task.command.split('|');
            const filePath = path.join(workingDirectory, filename.trim());

            // Check if the file has already been created
            if (createdFiles.has(filePath)) {
                console.warn(`File ${filePath} already exists. Skipping write_file command to prevent overwriting.`);
                return { stdout: `Skipped writing to ${filePath} to prevent overwriting.`, stderr: '' };
            }

            const content = contentLines.join('\n');
            await writeFileAsync(filePath, content, { encoding: 'utf8' });
            console.log(`File written successfully to ${filePath}`);
            createdFiles.add(filePath); // Mark the file as created
            return { stdout: `File written to ${filePath}`, stderr: '' };
        } catch (error) {
            console.error(`Error writing file: ${error.message}`);
            return { stdout: `File write failed: ${error.message}`, stderr: '' };
        }
    } else if (task.type === 'append_file') {
        // Handle appending to a file via Node.js's fs module
        try {
            const [filename, ...contentLines] = task.command.split('|');
            const filePath = path.join(workingDirectory, filename.trim());

            // Check if the file exists before appending
            try {
                await accessAsync(filePath, fs.constants.F_OK);
            } catch (err) {
                console.warn(`File ${filePath} does not exist. Creating it now.`);
                createdFiles.add(filePath); // Mark the file as created
            }

            const content = contentLines.join('\n');
            await appendFileAsync(filePath, content + '\n', { encoding: 'utf8' });
            console.log(`Content appended successfully to ${filePath}`);
            return { stdout: `Content appended to ${filePath}`, stderr: '' };
        } catch (error) {
            console.error(`Error appending to file: ${error.message}`);
            return { stdout: `File append failed: ${error.message}`, stderr: '' };
        }
    } else {
        // Handle shell and node commands
        let cmd;
        let args = [];
        let options = { cwd: workingDirectory, shell: true };

        if (task.type === 'node') {
            cmd = 'node';
            args = [task.command];
        } else {
            // Default to shell command
            cmd = task.command;
        }

        return new Promise((resolve, reject) => {
            let child;
            if (task.type === 'node') {
                child = spawn(cmd, args, options);
            } else {
                child = spawn(cmd, { ...options, stdio: 'pipe' });
            }

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                process.stdout.write(data);
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                process.stderr.write(data);
                stderr += data.toString();
                stdout += data.toString();
            });

            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                } else {
                    stdout += `Command exited with code ${code}: ${stderr}`
                    resolve ({ stdout, stderr })
                }
            });

            child.on('error', (err) => {
                stdout += `${err}`
                resolve({ stdout, stderr })
            });
        });
    }
}

async function sendMessageToModel(model, role, message) {
    // Record the user message in session memory
    sessionMemory.push({ role: role, message: message });
    saveSessionMemory(role, message);

    try {
        const logFilePath = path.join(absolutePath, 'llm_log.txt'); // Use absolutePath

        // Log the current session memory along with the user message
        const sessionMemoryString = JSON.stringify(sessionMemory, null, 2); // Convert session memory to a readable string
        await appendFileAsync(logFilePath, `\nSession Memory:\n${sessionMemoryString}\n`, { encoding: 'utf8' });

        await appendFileAsync(logFilePath, `\nUser: \n${message}\n`, { encoding: 'utf8' }); // Append to file
    } catch (err) {
        console.error("Error writing to llm_log.txt:", err);
    }

    const chatSession = model.startChat({
        generationConfig,
        history: sessionMemory.map(entry => ({ role: entry.role, parts: [{ text: entry.message }] })),
    });


    const response = await chatSession.sendMessage(message);
    const responseText = response.response.text();

    // Record the model's response in session memory
    sessionMemory.push({ role: "model", message: responseText });
    saveSessionMemory("model", responseText);

    try {
        const logFilePath = path.join(absolutePath, 'llm_log.txt'); // Use absolutePath
        await appendFileAsync(logFilePath, `\n LLM Response:\n${responseText}\n`, { encoding: 'utf8' }); // Append to file
    } catch (err) {
        console.error("Error writing to llm_log.txt:", err);
    }

    return responseText;
}

// Process a single pending task
async function processSingleTask(model, workingDirectory) {
    try {
        const task = await new Promise((resolve, reject) => {
            db.get(`SELECT * FROM tasks WHERE status = 'pending' ORDER BY id ASC LIMIT 1`, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });

        if (!task) {
            console.log("No pending tasks to process.");
            return false; // Indicate no tasks were processed
        }

        // Update task status to 'in_progress'
        await new Promise((resolve, reject) => {
            db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`, [task.id], (err) => {
                if (err) {
                    console.error(`Error updating task ID ${task.id} to in_progress:`, err);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

        if (task.command) {
            try {
                const { stdout, stderr } = await executeTask(task, workingDirectory);

                // Mark task as completed in the database
                await new Promise((resolve, reject) => {
                    db.run(`UPDATE tasks SET status = 'completed', output = ?, error = ? WHERE id = ?`, [stdout, stderr, task.id], (err) => {
                        if (err) {
                            console.error("Error updating task status:", err);
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });

                // Inform the model about the completed task
                const feedback = await sendMessageToModel(model, "user", `Task "${task.description}" completed executed, here's the report ${stdout}, is it the expected result from given task expected output? give another task if still not completed`);

                // Parse and add only one new task
                const newTasks = parseTasksFromResponse(feedback);
                if (newTasks.length > 1) {
                    console.warn("AI generated multiple tasks. Only the first task will be processed.");
                }
                if (newTasks.length > 0) {
                    console.log(`Added ${newTasks.length} new task(s) from feedback.`);
                }

                return true; // Indicate a task was processed
            } catch (error) {
                console.error(`Error executing task ID ${task.id}: ${error.message}`);

                // Increment retry count
                const newRetryCount = task.retries + 1;

                if (newRetryCount <= 3) { // Max 3 retries
                    await new Promise((resolve, reject) => {
                        db.run(`UPDATE tasks SET status = 'pending', retries = ? WHERE id = ?`, [newRetryCount, task.id], (err) => {
                            if (err) {
                                console.error("Error updating retry count:", err);
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    });
                    console.log(`Retrying task ID ${task.id} (${newRetryCount}/3)...`);
                } else {
                    await new Promise((resolve, reject) => {
                        db.run(`UPDATE tasks SET status = 'failed', error = ? WHERE id = ?`, [error.message, task.id], (err) => {
                            if (err) {
                                console.error("Error updating task status to failed:", err);
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    });

                    // Read the current code files to provide context
                    const codeFiles = await getCodeFilesContent(workingDirectory);
                    const codeContext = codeFiles.join('\n\n');

                    // Inform the model about the failed task and include the code context
                    const retryFeedback = await sendMessageToModel(model, "user", `The task "${task.description}" failed with error: "${error.message}". Here is the current code:\n\n${codeContext}\n\nPlease analyze the code, fix the error, and provide the next task.`);

                    // Parse and add only one new task
                    const retryTasks = parseTasksFromResponse(retryFeedback);
                    if (retryTasks.length > 1) {
                        console.warn("AI generated multiple tasks. Only the first task will be processed.");
                    }
                    if (retryTasks.length > 0) {
                        console.log(`Added ${retryTasks.length} retry/alternative task(s) from feedback.`);
                    }
                }

                return false; // Indicate the task was not processed successfully
            }
        } else {
            // No command to execute, mark as completed
            await new Promise((resolve, reject) => {
                db.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [task.id], (err) => {
                    if (err) {
                        console.error("Error updating task status:", err);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
            console.log(`Task ID ${task.id} has no command and is marked as completed.`);
            return true; // Indicate a task was processed
        }
    } catch (err) {
        console.error("Error processing tasks:", err);
        return false; // Indicate failure
    }
}

// Function to get the content of code files for context
async function getCodeFilesContent(workingDirectory) {
    const codeFiles = [];
    for (const filePath of createdFiles) {
        try {
            const content = await readFileAsync(filePath, 'utf8');
            codeFiles.push(`File: ${path.relative(workingDirectory, filePath)}\n---\n${content}`);
        } catch (err) {
            console.error(`Error reading file ${filePath}:`, err);
        }
    }
    return codeFiles;
}

// Initialize session memory
let sessionMemory = [];

// Function to prompt user input using readline
function promptUser(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

// Main function to run the chatbot
async function runBot() {
    try {
        // Step 1: Prompt the user for inputs
        const projectDescription = await promptUser('What would you like to build? ');
        if (!projectDescription.trim()) {
            console.error('Project description cannot be empty.');
            process.exit(1);
        }

        const workingDirectory = await promptUser('Enter the working directory path: ');
        if (!workingDirectory.trim()) {
            console.error('Working directory path cannot be empty.');
            process.exit(1);
        }

        // Step 2: Check if the working directory exists; if not, create it
        absolutePath = path.resolve(workingDirectory);
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

        // Step 3: Initialize the SQLite database in the working directory
        const dbPath = path.join(absolutePath, 'chatbot.db');
        initializeDatabase(dbPath);

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
        const row = await dbGetAsync(`SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'in_progress')`);

        if (row.count > 0) {
            console.log(`\nThere are still ${row.count} task(s) remaining. Continuing task processing...`);
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
process.on('SIGINT', async () => {
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
