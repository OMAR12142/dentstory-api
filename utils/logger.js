/**
 * Simple Structured Logger for DentStory
 * Designed to provide context (like dentist_id) for every error.
 */
const logger = {
  info: (message, context = {}) => {
    const timestamp = new Date().toISOString();
    console.log(`[INFO] ${timestamp} | ${message} | Context: ${JSON.stringify(context)}`);
  },

  error: (message, error = {}, context = {}) => {
    const timestamp = new Date().toISOString();
    console.error(`[ERROR] ${timestamp} | ${message}`);
    if (error.stack) {
      console.error(error.stack);
    }
    console.error(`Context: ${JSON.stringify(context)}`);
  },

  warn: (message, context = {}) => {
    const timestamp = new Date().toISOString();
    console.warn(`[WARN] ${timestamp} | ${message} | Context: ${JSON.stringify(context)}`);
  }
};

module.exports = logger;
