/**
 * Global error-handling middleware.
 * Express identifies error handlers by their 4-argument signature.
 */
const errorHandler = (err, req, res, _next) => {
  // Only log errors in development environment
  if (process.env.NODE_ENV !== 'production') {
    console.error('❌ Error:', err.message);
    if (err.stack) console.error(err.stack);
  }

  // Normalize Multer upload errors into clear 400 Bad Request responses
  if (err.name === 'MulterError') {
    let message = err.message || 'File upload failed';
    if (err.code === 'LIMIT_FILE_SIZE') {
      message = 'Image file is too large. Maximum allowed size exceeded.';
    } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      const limit = req?.originalUrl?.includes('/portfolio') ? 8 : 5;
      message = `Maximum of ${limit} images allowed per upload.`;
    }
    return res.status(400).json({ message });
  }

  const statusCode = err.statusCode || (res.statusCode === 200 ? 500 : res.statusCode);

  res.status(statusCode).json({
    message: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
