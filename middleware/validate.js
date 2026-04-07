/**
 * Zod validation middleware factory.
 * Validates `req.body` against the supplied Zod schema.
 *
 * Usage:  router.post('/', validate(myZodSchema), handler);
 */
const validate = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.body);

  if (!result.success) {
    const error = new Error(
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
    error.statusCode = 400;
    throw error;
  }

  // Replace body with the parsed (coerced / transformed) data
  req.body = result.data;
  next();
};

module.exports = validate;
