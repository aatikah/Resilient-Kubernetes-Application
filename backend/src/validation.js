'use strict';

const MAX_TITLE_LENGTH = 200;

function validateTaskTitle(value) {
  if (typeof value !== 'string') {
    return { error: 'title must be a string' };
  }

  const title = value.trim();
  if (title.length === 0) {
    return { error: 'title must not be empty' };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return { error: `title must be at most ${MAX_TITLE_LENGTH} characters` };
  }

  return { title };
}

function parseTaskId(value) {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

module.exports = { parseTaskId, validateTaskTitle };
