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
let initialMessage

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
let absolutePath;

// Utility function to pause execution for a specified duration (in milliseconds)
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Track created files to prevent overwriting
const createdFiles = new Set();

// Flag to indicate if a task is currently being processed
let isProcessing = false;

const generationConfig = {
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,  // Adjust as necessary
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

    // Drop existing 'tasks' table if it exists
    db.serialize(() => {
        db.run(`DROP TABLE IF EXISTS tasks`);

        // Recreate the 'tasks' table with updated CHECK constraint
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            description TEXT,
            command TEXT,
            type TEXT CHECK( type IN ('shell','node', 'write_file', 'append_file', 'spawn_child_process', 'retrieve_child_process', 'close_child_process') ) NOT NULL DEFAULT 'shell',
            status TEXT CHECK( status IN ('pending','in_progress','completed','failed') ) NOT NULL DEFAULT 'pending',
            output TEXT,
            error TEXT,
            retries INTEGER DEFAULT 0
        )`, (err) => {
            if (err) {
                console.error("Error creating tasks table:", err);
                process.exit(1);
            } else {
                console.log("Tasks table created with updated constraints.");
            }
        });

        // Ensure 'session_memory' table exists
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


const EventEmitter = require('events');
const childProcessEmitter = new EventEmitter();

// Map to store active child processes by task ID
const childProcesses = new Map();

function spawn_child_process(command, args = [], options = {}) {
    const child = spawn(command, args, { ...options, shell: true });

    // Initialize process info object
    const processInfo = {
        child,
        stdout: '',
        stderr: ''
    };

    // Capture stdout and stderr
    child.stdout.on('data', (data) => {
        const output = data.toString();
        processInfo.stdout += output;
        childProcessEmitter.emit('output', output);
    });

    child.stderr.on('data', (data) => {
        const errorOutput = data.toString();
        processInfo.stderr += errorOutput;
        childProcessEmitter.emit('output', errorOutput);
    });

    child.on('close', (code) => {
        console.log(`Child process exited with code ${code}`);
        processInfo.stdout += `Child process exited with code ${code};`
        childProcessEmitter.emit('output', `Process exited with code ${code}`);
    });

    return processInfo;
}


// Function to retrieve the output log of a spawned child process
function retrieve_child_process_output(taskId) {
    const processInfo = childProcesses.get(taskId);
    if (!processInfo) {
        console.warn(`No active child process found for task ID ${taskId}`);
        return null;
    }
    return {
        stdout: processInfo.stdout,
        stderr: processInfo.stderr,
    };
}

// Function to close a child process by task ID
const kill = require('tree-kill');

function close_child_process(taskId) {
    const processInfo = childProcesses.get(taskId);
    if (processInfo) {
        const pid = processInfo.child.pid;
        kill(pid, 'SIGTERM', (err) => {
            if (err) {
                console.error(`Error killing process ${pid}:`, err);
            } else {
                console.log(`Child process for task ID ${taskId} terminated.`);
                childProcesses.delete(taskId);  // Remove from map
            }
        });
        return true;
    }
    console.warn(`No active child process found for task ID ${taskId}`);
    return false;
}

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
    // Regex to match command and type, allowing for escaped quotes within the command
    const commandMatch = firstTaskLine.match(/\$execute_command\("((?:\\.|[^"\\])*)"\)/);
    const typeMatch = firstTaskLine.match(/\$command_type\("(.+?)"\)/);
    const descriptionMatch = firstTaskLine.match(/^(?:\d+\.\s)?(.+?)\s*\$execute_command\(".*"\)\s*\$command_type\(".*"\)$/);

    const taskDescription = descriptionMatch ? descriptionMatch[1].trim() : firstTaskLine.trim();

    let command = null;
    if (commandMatch) {
        command = commandMatch[1];

        // Unescape any escaped quotes and backslashes
        command = command.replace(/\\(["\\])/g, '$1');
    }

    // Define Allowed Types
    const allowedTypes = [
        'shell',
        'node',
        'write_file',
        'append_file',
        'spawn_child_process',
        'retrieve_child_process',
        'close_child_process',
        'list_files',
        'read_file',
        'delete_file'
    ];

    const type = typeMatch ? typeMatch[1].toLowerCase() : 'shell'; // Default to 'shell' if not specified

    // Validate the 'type'
    if (!allowedTypes.includes(type)) {
        console.warn(`Skipped task "${taskDescription}" due to invalid type: "${type}".`);
        return tasks; // Skip this task
    }

    // Skip tasks with empty commands to prevent overwriting files unintentionally
    if (
        (type === 'write_file' || type === 'append_file' || type === 'read_file' || type === 'delete_file') &&
        (!command || command.trim() === '')
    ) {
        console.warn(`Skipped task "${taskDescription}" due to empty command.`);
        return tasks;
    }

    // Additional Validation for New Task Types
    if (type === 'list_files') {
        const expectedCommandPatterns = [/^list\s+files$/i];
        const isValidCommand = expectedCommandPatterns.some(pattern => pattern.test(command));
        if (!isValidCommand) {
            console.warn(`Skipped task "${taskDescription}" due to invalid command for type "list_files": "${command}".`);
            return tasks;
        }
    }

    if (type === 'read_file' || type === 'delete_file') {
        const filename = command.trim();
        const invalidFilenamePatterns = [/\0/, /[<>:"|?*]/];
        const isValidFilename = !invalidFilenamePatterns.some(pattern => pattern.test(filename)) && filename.length > 0;
        if (!isValidFilename) {
            console.warn(`Skipped task "${taskDescription}" due to invalid filename: "${filename}".`);
            return tasks;
        }
    }

    // Add the task to the list
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



// Function to execute a shell, node, or file writing command and stream outputs
async function executeTask(task, workingDirectory) {
    if (!task.command) {
        // No command to execute
        return { stdout: '', stderr: '' };
    }

    console.log(`\nExecuting Task ID ${task.id}: ${task.description}`);
    console.log(`Command: ${task.command}`);

    if (task.type === 'spawn_child_process' || task.command == 'node server.js' || task.command == 'node server.js &' || task.command == 'npm start') {
        const [command, ...args] = task.command.split(' ');
        const processInfo = spawn_child_process(command, args, { cwd: workingDirectory, shell: true });
        childProcesses.set(task.id, processInfo);
        return { stdout: `Child process started for task ${task.id}`, stderr: '' };
    } else if (task.type === 'retrieve_child_process') {
        const match = task.command.match(/retrieve log for task (\d+)/i);
        if (match && match[1]) {
            const targetTaskId = parseInt(match[1], 10);
            const output = retrieve_child_process_output(targetTaskId);
            if (output) {
                return { stdout: output.stdout, stderr: output.stderr };
            }
            return { stdout: '', stderr: `No output available for task ID ${targetTaskId}.` };
        } else {
            return { stdout: '', stderr: 'Invalid command format. Expected "retrieve log for task <id>".' };
        }
    } else if (task.type === 'close_child_process') {
        const match = task.command.match(/close process for task (\d+)/i);
        if (match && match[1]) {
            const targetTaskId = parseInt(match[1], 10);
            const closed = close_child_process(targetTaskId);
            return closed ? { stdout: `Child process for task ${targetTaskId} closed.`, stderr: '' } : { stdout: '', stderr: `Failed to close process for task ID ${targetTaskId}.` };
        } else {
            return { stdout: '', stderr: 'Invalid command format. Expected "close process for task <id>".' };
        }
    } else if (task.type === 'write_file') {
        try {
            const [filename, contentString] = task.command.split('||');
            if (!filename || !contentString) {
                throw new Error("Invalid write_file command format. Expected 'filename||content'.");
            }

            const filePath = path.join(workingDirectory, filename.trim());

            let content;
            if (filename.trim().endsWith('.json')) {
                try {
                    const jsonObject = JSON.parse(contentString);
                    content = JSON.stringify(jsonObject, null, 2);
                } catch (err) {
                    console.error(`Error parsing JSON content for ${filename}:`, err);
                    return { stdout: '', stderr: `Failed to parse JSON: ${err.message}` };
                }
            } else {
                content = contentString.split('|').join('\n');
            }

            await writeFileAsync(filePath, content, { encoding: 'utf8' });
            console.log(`File written successfully to ${filePath}`);
            createdFiles.add(filePath);
            return { stdout: `File written to ${filePath}`, stderr: '' };
        } catch (error) {
            console.error(`Error writing file: ${error.message}`);
            return { stdout: `File write failed: ${error.message}`, stderr: '' };
        }
    } else if (task.type === 'append_file') {
        try {
            const [filename, ...contentLines] = task.command.split('|');
            const filePath = path.join(workingDirectory, filename.trim());

            try {
                await accessAsync(filePath, fs.constants.F_OK);
            } catch (err) {
                console.warn(`File ${filePath} does not exist. Creating it now.`);
                createdFiles.add(filePath);
            }

            const content = contentLines.join('\n');
            await appendFileAsync(filePath, content + '\n', { encoding: 'utf8' });
            console.log(`Content appended successfully to ${filePath}`);
            return { stdout: `Content appended to ${filePath}`, stderr: '' };
        } catch (error) {
            console.error(`Error appending to file: ${error.message}`);
            return { stdout: `File append failed: ${error.message}`, stderr: '' };
        }
    } else if (task.type === 'list_files') {
        try {
            const files = await readdirAsync(workingDirectory);
            const fileList = files.join('\n');
            return { stdout: `Files in ${workingDirectory}:\n${fileList}`, stderr: '' };
        } catch (error) {
            console.error(`Error listing files: ${error.message}`);
            return { stdout: '', stderr: `File listing failed: ${error.message}` };
        }
    } else if (task.type === 'read_file') {
        try {
            const filename = task.command.trim();
            const filePath = path.join(workingDirectory, filename);

            const content = await readFileAsync(filePath, { encoding: 'utf8' });
            return { stdout: `Contents of ${filename}:\n${content}`, stderr: '' };
        } catch (error) {
            console.error(`Error reading file: ${error.message}`);
            return { stdout: '', stderr: `File read failed: ${error.message}` };
        }
    } else if (task.type === 'delete_file') {
        try {
            const filename = task.command.trim();
            const filePath = path.join(workingDirectory, filename);

            await unlinkAsync(filePath);
            console.log(`File ${filePath} deleted successfully.`);
            createdFiles.delete(filePath);
            return { stdout: `File ${filename} deleted successfully.`, stderr: '' };
        } catch (error) {
            console.error(`Error deleting file: ${error.message}`);
            return { stdout: '', stderr: `File deletion failed: ${error.message}` };
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
                    stdout += `Command exited with code ${code}: ${stderr}`;
                    resolve({ stdout, stderr });
                }
            });

            child.on('error', (err) => {
                stdout += `${err}`;
                resolve({ stdout, stderr });
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

    // **Limit the history to the last 10 messages**
    let recentSessionMemory = sessionMemory.slice(-20);

    // **Ensure the first message in the history is from 'user'**
    if (recentSessionMemory.length > 0 && recentSessionMemory[0].role !== 'user') {
        // **Find the index of the first 'user' message in the sliced history**
        const firstUserIndex = recentSessionMemory.findIndex(msg => msg.role === 'user');

        if (firstUserIndex !== -1) {
            // **Slice the array starting from the first 'user' message**
            recentSessionMemory = recentSessionMemory.slice(firstUserIndex);
        } else {
            // **If no 'user' message is found, prepend the initialMessage**
            // **Assuming initialMessage is defined globally or accessible here**
            recentSessionMemory = [
                { role: 'user', message: initialMessage },
                ...recentSessionMemory.slice(-9) // Keep the last 9 messages to maintain the limit
            ];
        }
    }

    // **Optional: Ensure that the history does not exceed 10 messages after adjustments**
    if (recentSessionMemory.length > 20) {
        recentSessionMemory = recentSessionMemory.slice(-20);
    }

    // **Start the chat session with the adjusted history**
    const chatSession = model.startChat({
        generationConfig,
        history: recentSessionMemory.map(entry => ({ role: entry.role, parts: [{ text: entry.message }] })),
    });

    // **Send the user's message to the model**
    const response = await chatSession.sendMessage(message);
    const responseText = response.response.text();

    // Record the model's response in session memory
    sessionMemory.push({ role: "model", message: responseText });
    saveSessionMemory("model", responseText);

    try {
        const logFilePath = path.join(absolutePath, 'llm_log.txt'); // Use absolutePath
        await appendFileAsync(logFilePath, `\nLLM Response:\n${responseText}\n`, { encoding: 'utf8' }); // Append to file
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
                const feedback = await sendMessageToModel(model, "user", `Task "${task.description}" completed executed, here's the report ${stdout}, is it the expected result from given task expected output? give another task if still not completed, you need to remember you have this               - $command_type specifies the type of command:
                - "shell"
                - "node"
                - "write_file"
                - "append_file"
                - "spawn_child_process"
                - "retrieve_child_process"
                - "close_child_process"
                - "list_files"
                - "read_file"
                - "delete_file"
                for performing utilities`);

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
              - $execute_command specifies the command to execute.
              - $command_type specifies the type of command:
                - "shell"
                - "node"
                - "write_file"
                - "append_file"
                - "spawn_child_process"
                - "retrieve_child_process"
                - "close_child_process"
                - "list_files"
                - "read_file"
                - "delete_file"
              - For 'write_file' type, use the format "filename||line1|line2|...|lineN".
              - For 'append_file' type, use the format "filename|line1|line2|...|lineN".
              - For 'spawn_child_process' type, provide the command and arguments as one string, e.g., "node server.js".
              - For 'retrieve_child_process', specify "retrieve log for task <task_id>" to get logs from a running child process.
              - For 'close_child_process', specify "close process for task <task_id>" to terminate a child process.
              - For 'list_files', specify "list files" to retrieve a list of all files in the working directory.
              - For 'read_file', specify the filename to read its contents, e.g., "app.js" So you can see the file content in case you need it.
              - For 'delete_file', specify the filename to delete, e.g., "old_module.js".
              - Ensure that all internal quotes within the command are properly escaped using backslashes (e.g., \\" for double quotes).
              - Replace newline characters with pipe symbols ('|') and ensure that backslashes are escaped.
              - Generate only one task per response.
              - When an error occurs, you will be provided with the current code. Analyze it, identify the issue, and provide a corrected task.
              - Avoid using interactive inputs like input().
              - Use command-line arguments (sys.argv) for user inputs instead.
              - Ensure that all commands are compatible with Windows operating systems.
              - Do not generate tasks that overwrite existing files unless it's the initial creation.
        
              Example:
              1. Create the main Python file [$execute_command("fibonacci.py||import sys")] [$command_type("write_file")]
              2. Get the number of Fibonacci numbers to generate from command-line arguments [$execute_command("fibonacci.py|try:|    num_terms = int(sys.argv[1])|except IndexError:|    print('Usage: python fibonacci.py <number_of_terms>')|    sys.exit(1)|except ValueError:|    print('Invalid input. Please enter an integer.')|    sys.exit(1)")] [$command_type("append_file")]
              3. Define an iterative Fibonacci function [$execute_command("fibonacci.py|def fibonacci_iterative(n):|    if n <= 0:|        return []|    elif n == 1:|        return [0]|    else:|        list_fib = [0, 1]|        while len(list_fib) < n:|            next_fib = list_fib[-1] + list_fib[-2]|            list_fib.append(next_fib)|        return list_fib")] [$command_type("append_file")]
              4. Spawn a process to run the API server [$execute_command("node server.js")] [$command_type("spawn_child_process")]
              5. Retrieve the output log for the API server task [$execute_command("retrieve log for task 4")] [$command_type("retrieve_child_process")]
              6. Close the API server process [$execute_command("close process for task 4")] [$command_type("close_child_process")]
              7. List all files in the project directory [$execute_command("list files")] [$command_type("list_files")]
              8. Read the contents of the README file [$execute_command("README.md")] [$command_type("read_file")]
              9. Delete the temporary configuration file [$execute_command("temp_config.json")] [$command_type("delete_file")]
        
              Currently, the user is asking about ${initialMessage}. If done, make no task.
            `,
        });
        


        // Step 5: Plan the project based on user input
        initialMessage = `User wants to: "${projectDescription}". Analyze the task and create a detailed plan with steps, required libraries, and commands to execute. Use the specified format for tasks. Generate only one task per response.`;
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
            await sleep(3000);
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