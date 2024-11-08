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
