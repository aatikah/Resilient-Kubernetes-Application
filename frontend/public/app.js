'use strict';

const form = document.querySelector('#task-form');
const input = document.querySelector('#task-title');
const tasks = document.querySelector('#tasks');
const message = document.querySelector('#message');
const refreshButton = document.querySelector('#refresh');

async function request(path, options) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function renderTasks(items) {
  tasks.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No tasks yet. Add one above to get started.';
    tasks.append(empty);
    return;
  }

  for (const task of items) {
    const item = document.createElement('li');
    item.className = 'task';
    const title = document.createElement('span');
    title.textContent = task.title;
    const remove = document.createElement('button');
    remove.className = 'remove-button';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${task.title}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await request(`/api/tasks/${task.id}`, { method: 'DELETE' });
        await loadTasks('Task removed.');
      } catch (error) {
        remove.disabled = false;
        showMessage(error.message, true);
      }
    });
    item.append(title, remove);
    tasks.append(item);
  }
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

async function loadTasks(successMessage) {
  try {
    const items = await request('/api/tasks');
    renderTasks(items);
    showMessage(successMessage || `${items.length} ${items.length === 1 ? 'task' : 'tasks'} loaded.`);
  } catch (error) {
    showMessage(error.message, true);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (!title) {
    input.focus();
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title })
    });
    input.value = '';
    await loadTasks('Task added.');
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    submitButton.disabled = false;
    input.focus();
  }
});

refreshButton.addEventListener('click', () => loadTasks());
loadTasks();
