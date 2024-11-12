# mini-devin-gemini

![Demo](https://raviadi12.github.io/ScreenRecording2024-11-10134102-ezgif.com-video-to-gif-converter.gif)

A Devin-like tool powered by Gemini, designed for enhanced code generation and task management.

# Features

* **Step-by-step software creation:**  Breaks down complex projects into manageable tasks.
* **AI-powered task management:**  Uses Gemini to generate, execute, and track tasks.
* **Automated code generation:** Creates code files based on task descriptions.
* **Command execution:** Executes shell and Node.js commands.
* **File manipulation:** Supports writing, appending, reading, listing, and deleting files.
* **Child process management:**  Spawns, monitors, and terminates child processes.
* **Session memory:** Retains conversation history for context and continuity.
* **SQLite integration:** Stores tasks and session data for persistence.
* **Error handling and retries:**  Handles command errors with retries and AI-guided recovery.
* **Detailed logging:** Logs LLM interactions and task outputs for review.

# Example Usage

1. **Set up your environment:**
    * Create a `.env` file in the project root.
    * Add your Gemini API key: `GEMINI_API_KEY=YOUR_API_KEY`

2. **Run the application:**
    ```bash
    node index.js
    ```

3. **Follow the prompts:**
    * You'll be asked to describe the project you want to build.
    * Specify the working directory where the project files will be created.

The AI will then generate a plan and start executing tasks.  Follow the console output for progress and any additional instructions.

Gemini Can run the following command for achieving the task you want

* **Supported Command Types:**

    * `shell`: Executes shell commands.
    * `node`: Executes Node.js commands.
    * `write_file`: Creates or overwrites files with specified content.
    * `append_file`: Appends content to existing files.
    * `spawn_child_process`: Starts a child process.
    * `retrieve_child_process`: Retrieves logs from a running child process.
    * `close_child_process`: Terminates a child process.
    * `list_files`: Lists files in the working directory.
    * `read_file`: Reads the content of a file.
    * `delete_file`: Deletes a file.

# Additional Notes
The code currently is in not structured mode, any commit to restrutcture or refactor code is welcome! 

* If you want to change the model, you can change the model inside the `index.js` at Line around 742

# Future Enhancements

* **Improved code analysis:** More robust error detection and correction.
* **Support for more languages:** Expand beyond shell and Node.js.
* **Plugin system:** Allow users to extend functionality.
* **Interactive debugging:**  Enable interactive debugging sessions with the AI.

