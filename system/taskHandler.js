async function sendMessageToModel(model, role, message) {
  // Record the user message in session memory
  sessionMemory.push({ role: role, message: message });
  saveSessionMemory(role, message);

  try {
    const logFilePath = path.join(absolutePath, "llm_log.txt"); // Use absolutePath

    // Log the current session memory along with the user message
    const sessionMemoryString = JSON.stringify(sessionMemory, null, 2); // Convert session memory to a readable string
    await appendFileAsync(
      logFilePath,
      `\nSession Memory:\n${sessionMemoryString}\n`,
      { encoding: "utf8" }
    );

    await appendFileAsync(logFilePath, `\nUser: \n${message}\n`, {
      encoding: "utf8",
    }); // Append to file
  } catch (err) {
    console.error("Error writing to llm_log.txt:", err);
  }

  const chatSession = model.startChat({
    generationConfig,
    history: sessionMemory.map((entry) => ({
      role: entry.role,
      parts: [{ text: entry.message }],
    })),
  });

  const response = await chatSession.sendMessage(message);
  const responseText = response.response.text();

  // Record the model's response in session memory
  sessionMemory.push({ role: "model", message: responseText });
  saveSessionMemory("model", responseText);

  try {
    const logFilePath = path.join(absolutePath, "llm_log.txt"); // Use absolutePath
    await appendFileAsync(logFilePath, `\n LLM Response:\n${responseText}\n`, {
      encoding: "utf8",
    }); // Append to file
  } catch (err) {
    console.error("Error writing to llm_log.txt:", err);
  }

  return responseText;
}

// Process a single pending task
async function processSingleTask(model, workingDirectory) {
  try {
    const task = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM tasks WHERE status = 'pending' ORDER BY id ASC LIMIT 1`,
        (err, row) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        }
      );
    });

    if (!task) {
      console.log("No pending tasks to process.");
      return false; // Indicate no tasks were processed
    }

    // Update task status to 'in_progress'
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE tasks SET status = 'in_progress' WHERE id = ?`,
        [task.id],
        (err) => {
          if (err) {
            console.error(
              `Error updating task ID ${task.id} to in_progress:`,
              err
            );
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });

    if (task.command) {
      try {
        const { stdout, stderr } = await executeTask(task, workingDirectory);

        // Mark task as completed in the database
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE tasks SET status = 'completed', output = ?, error = ? WHERE id = ?`,
            [stdout, stderr, task.id],
            (err) => {
              if (err) {
                console.error("Error updating task status:", err);
                reject(err);
              } else {
                resolve();
              }
            }
          );
        });

        // Inform the model about the completed task
        const feedback = await sendMessageToModel(
          model,
          "user",
          `Task "${task.description}" completed executed, here's the report ${stdout}, is it the expected result from given task expected output? give another task if still not completed`
        );

        // Parse and add only one new task
        const newTasks = parseTasksFromResponse(feedback);
        if (newTasks.length > 1) {
          console.warn(
            "AI generated multiple tasks. Only the first task will be processed."
          );
        }
        if (newTasks.length > 0) {
          console.log(`Added ${newTasks.length} new task(s) from feedback.`);
        }

        return true; // Indicate a task was processed
      } catch (error) {
        console.error(`Error executing task ID ${task.id}: ${error.message}`);

        // Increment retry count
        const newRetryCount = task.retries + 1;

        if (newRetryCount <= 3) {
          // Max 3 retries
          await new Promise((resolve, reject) => {
            db.run(
              `UPDATE tasks SET status = 'pending', retries = ? WHERE id = ?`,
              [newRetryCount, task.id],
              (err) => {
                if (err) {
                  console.error("Error updating retry count:", err);
                  reject(err);
                } else {
                  resolve();
                }
              }
            );
          });
          console.log(`Retrying task ID ${task.id} (${newRetryCount}/3)...`);
        } else {
          await new Promise((resolve, reject) => {
            db.run(
              `UPDATE tasks SET status = 'failed', error = ? WHERE id = ?`,
              [error.message, task.id],
              (err) => {
                if (err) {
                  console.error("Error updating task status to failed:", err);
                  reject(err);
                } else {
                  resolve();
                }
              }
            );
          });

          // Read the current code files to provide context
          const codeFiles = await getCodeFilesContent(workingDirectory);
          const codeContext = codeFiles.join("\n\n");

          // Inform the model about the failed task and include the code context
          const retryFeedback = await sendMessageToModel(
            model,
            "user",
            `The task "${task.description}" failed with error: "${error.message}". Here is the current code:\n\n${codeContext}\n\nPlease analyze the code, fix the error, and provide the next task.`
          );

          // Parse and add only one new task
          const retryTasks = parseTasksFromResponse(retryFeedback);
          if (retryTasks.length > 1) {
            console.warn(
              "AI generated multiple tasks. Only the first task will be processed."
            );
          }
          if (retryTasks.length > 0) {
            console.log(
              `Added ${retryTasks.length} retry/alternative task(s) from feedback.`
            );
          }
        }

        return false; // Indicate the task was not processed successfully
      }
    } else {
      // No command to execute, mark as completed
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE tasks SET status = 'completed' WHERE id = ?`,
          [task.id],
          (err) => {
            if (err) {
              console.error("Error updating task status:", err);
              reject(err);
            } else {
              resolve();
            }
          }
        );
      });
      console.log(
        `Task ID ${task.id} has no command and is marked as completed.`
      );
      return true; // Indicate a task was processed
    }
  } catch (err) {
    console.error("Error processing tasks:", err);
    return false; // Indicate failure
  }
}
