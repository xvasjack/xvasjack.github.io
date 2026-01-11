/**
 * AI Computer Agent - Host Controller
 *
 * This server runs on your main PC and provides:
 * - Web UI for task input and monitoring
 * - WebSocket connection to VM agent
 * - Task queue management
 * - Real-time status updates
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_TASK_DURATION_MINUTES = 240; // 4 hours max
const STATE_FILE = path.join(__dirname, 'state.json');

// ============================================================================
// State Persistence
// ============================================================================

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const saved = JSON.parse(data);
      console.log(`Loaded state: ${saved.taskHistory?.length || 0} historical tasks`);
      return {
        vmAgent: null,
        currentTask: saved.currentTask || null,
        taskHistory: saved.taskHistory || [],
        uiClients: new Set(),
        latestScreenshot: null,
        stats: saved.stats || {
          totalTasks: 0,
          completedTasks: 0,
          failedTasks: 0,
          totalPRsMerged: 0,
        },
      };
    }
  } catch (e) {
    console.error('Failed to load state:', e.message);
  }
  return null;
}

function saveState() {
  try {
    const toSave = {
      currentTask: state.currentTask ? state.currentTask.toJSON() : null,
      taskHistory: state.taskHistory.map((t) => t.toJSON ? t.toJSON() : t),
      stats: state.stats,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// Save state periodically and on changes
setInterval(saveState, 30000); // Every 30 seconds

// ============================================================================
// State Management
// ============================================================================

const state = loadState() || {
  // Connected VM agent
  vmAgent: null,

  // Current task
  currentTask: null,

  // Task history
  taskHistory: [],

  // Connected UI clients
  uiClients: new Set(),

  // Latest screenshot from VM
  latestScreenshot: null,

  // Task stats
  stats: {
    totalTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    totalPRsMerged: 0,
  },
};

// ============================================================================
// Task Management
// ============================================================================

class Task {
  constructor(description, maxDurationMinutes = 120) {
    this.id = uuidv4();
    this.description = description;
    this.maxDurationMinutes = Math.min(maxDurationMinutes, MAX_TASK_DURATION_MINUTES);
    this.status = 'pending';
    this.plan = null;
    this.context = null;
    this.createdAt = new Date().toISOString();
    this.startedAt = null;
    this.completedAt = null;
    this.iterations = 0;
    this.prsMerged = 0;
    this.messages = [];
    this.result = null;
  }

  toJSON() {
    return {
      id: this.id,
      description: this.description,
      maxDurationMinutes: this.maxDurationMinutes,
      status: this.status,
      plan: this.plan,
      context: this.context,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      iterations: this.iterations,
      prsMerged: this.prsMerged,
      messages: this.messages.slice(-20), // Last 20 messages
      result: this.result,
    };
  }
}

function createTask(description, maxDurationMinutes) {
  const task = new Task(description, maxDurationMinutes);
  state.stats.totalTasks++;
  return task;
}

// ============================================================================
// WebSocket Handling
// ============================================================================

wss.on('connection', (ws, req) => {
  const isVMAgent = req.url === '/agent';

  if (isVMAgent) {
    console.log('VM Agent connected');
    state.vmAgent = ws;

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        handleVMMessage(message);
      } catch (e) {
        console.error('Error parsing VM message:', e);
      }
    });

    ws.on('close', () => {
      console.log('VM Agent disconnected');
      state.vmAgent = null;
      broadcastToUI({ type: 'vm_status', payload: { connected: false } });
    });

    ws.on('error', (error) => {
      console.error('VM Agent error:', error);
    });

    broadcastToUI({ type: 'vm_status', payload: { connected: true } });
  } else {
    // UI client
    console.log('UI client connected');
    state.uiClients.add(ws);

    // Send current state
    ws.send(JSON.stringify({
      type: 'init',
      payload: {
        vmConnected: state.vmAgent !== null,
        currentTask: state.currentTask ? state.currentTask.toJSON() : null,
        stats: state.stats,
        latestScreenshot: state.latestScreenshot,
      },
    }));

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        handleUIMessage(ws, message);
      } catch (e) {
        console.error('Error parsing UI message:', e);
      }
    });

    ws.on('close', () => {
      console.log('UI client disconnected');
      state.uiClients.delete(ws);
    });
  }
});

function handleVMMessage(message) {
  const { type, payload } = message;

  switch (type) {
    case 'task_update':
      if (state.currentTask && state.currentTask.id === payload.task_id) {
        state.currentTask.status = payload.status;
        state.currentTask.iterations = payload.iteration;
        state.currentTask.prsMerged = payload.prs_merged;
        state.currentTask.messages.push({
          time: new Date().toISOString(),
          message: payload.message,
        });

        if (payload.screenshot_base64) {
          state.latestScreenshot = payload.screenshot_base64;
        }

        broadcastToUI({
          type: 'task_update',
          payload: {
            task: state.currentTask.toJSON(),
            screenshot: payload.screenshot_base64,
          },
        });
      }
      break;

    case 'task_result':
      if (state.currentTask && state.currentTask.id === payload.task_id) {
        state.currentTask.status = payload.status;
        state.currentTask.completedAt = new Date().toISOString();
        state.currentTask.result = payload.summary;
        state.currentTask.iterations = payload.iterations;
        state.currentTask.prsMerged = payload.prs_merged;

        state.stats.totalPRsMerged += payload.prs_merged;

        if (payload.status === 'completed') {
          state.stats.completedTasks++;
        } else {
          state.stats.failedTasks++;
        }

        state.taskHistory.unshift(state.currentTask);
        state.taskHistory = state.taskHistory.slice(0, 50); // Keep last 50

        broadcastToUI({
          type: 'task_complete',
          payload: {
            task: state.currentTask.toJSON(),
            stats: state.stats,
          },
        });

        state.currentTask = null;
        saveState(); // Persist on task completion
      }
      break;

    case 'plan_proposal':
      if (state.currentTask) {
        state.currentTask.plan = payload.plan;
        state.currentTask.status = 'awaiting_approval';

        broadcastToUI({
          type: 'plan_proposal',
          payload: {
            taskId: state.currentTask.id,
            plan: payload.plan,
          },
        });
      }
      break;

    case 'screenshot_response':
      state.latestScreenshot = payload.screenshot;
      broadcastToUI({
        type: 'screenshot',
        payload: { screenshot: payload.screenshot },
      });
      break;
  }
}

function handleUIMessage(ws, message) {
  const { type, payload } = message;

  switch (type) {
    case 'new_task':
      if (state.currentTask && state.currentTask.status === 'running') {
        ws.send(JSON.stringify({
          type: 'error',
          payload: { message: 'A task is already running' },
        }));
        return;
      }

      const task = createTask(payload.description, payload.maxDurationMinutes);
      state.currentTask = task;

      // If VM is connected, send the task
      if (state.vmAgent) {
        state.vmAgent.send(JSON.stringify({
          type: 'new_task',
          payload: {
            id: task.id,
            description: task.description,
            max_duration_minutes: task.maxDurationMinutes,
            context: payload.context,
          },
        }));
        task.status = 'planning';
        task.startedAt = new Date().toISOString();
      } else {
        task.status = 'waiting_for_vm';
      }

      broadcastToUI({
        type: 'task_created',
        payload: { task: task.toJSON() },
      });
      break;

    case 'approve_plan':
      if (state.currentTask && state.vmAgent) {
        state.currentTask.status = 'running';
        state.currentTask.plan = payload.plan;

        state.vmAgent.send(JSON.stringify({
          type: 'plan_approved',
          payload: {
            task_id: state.currentTask.id,
            plan: payload.plan,
          },
        }));

        broadcastToUI({
          type: 'task_update',
          payload: { task: state.currentTask.toJSON() },
        });
      }
      break;

    case 'reject_plan':
      if (state.currentTask && state.vmAgent) {
        state.vmAgent.send(JSON.stringify({
          type: 'plan_rejected',
          payload: {
            task_id: state.currentTask.id,
            feedback: payload.feedback,
          },
        }));
      }
      break;

    case 'cancel_task':
      if (state.currentTask && state.vmAgent) {
        state.vmAgent.send(JSON.stringify({
          type: 'cancel_task',
          payload: { task_id: state.currentTask.id },
        }));

        state.currentTask.status = 'cancelled';
        state.currentTask.completedAt = new Date().toISOString();
        state.taskHistory.unshift(state.currentTask);
        state.currentTask = null;

        broadcastToUI({
          type: 'task_cancelled',
          payload: {},
        });
      }
      break;

    case 'user_input':
      if (state.currentTask && state.vmAgent) {
        state.vmAgent.send(JSON.stringify({
          type: 'user_input',
          payload: {
            task_id: state.currentTask.id,
            input: payload.input,
          },
        }));
      }
      break;

    case 'request_screenshot':
      if (state.vmAgent) {
        state.vmAgent.send(JSON.stringify({
          type: 'screenshot_request',
          payload: {},
        }));
      }
      break;

    case 'get_history':
      ws.send(JSON.stringify({
        type: 'history',
        payload: { tasks: state.taskHistory.map((t) => t.toJSON()) },
      }));
      break;
  }
}

function broadcastToUI(message) {
  const data = JSON.stringify(message);
  state.uiClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// ============================================================================
// Express Routes
// ============================================================================

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.get('/api/status', (req, res) => {
  res.json({
    vmConnected: state.vmAgent !== null,
    currentTask: state.currentTask ? state.currentTask.toJSON() : null,
    stats: state.stats,
  });
});

app.get('/api/history', (req, res) => {
  res.json({
    tasks: state.taskHistory.map((t) => t.toJSON()),
  });
});

app.post('/api/task', (req, res) => {
  const { description, maxDurationMinutes, context } = req.body;

  if (!description) {
    return res.status(400).json({ error: 'Description required' });
  }

  if (state.currentTask && state.currentTask.status === 'running') {
    return res.status(409).json({ error: 'Task already running' });
  }

  const task = createTask(description, maxDurationMinutes || 120);
  task.context = context;
  state.currentTask = task;

  if (state.vmAgent) {
    state.vmAgent.send(JSON.stringify({
      type: 'new_task',
      payload: {
        id: task.id,
        description: task.description,
        max_duration_minutes: task.maxDurationMinutes,
        context: context,
      },
    }));
    task.status = 'planning';
    task.startedAt = new Date().toISOString();
  } else {
    task.status = 'waiting_for_vm';
  }

  res.json({ task: task.toJSON() });
});

app.post('/api/task/:id/approve', (req, res) => {
  const { plan } = req.body;

  if (!state.currentTask || state.currentTask.id !== req.params.id) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (state.vmAgent) {
    state.currentTask.status = 'running';
    state.currentTask.plan = plan;

    state.vmAgent.send(JSON.stringify({
      type: 'plan_approved',
      payload: {
        task_id: state.currentTask.id,
        plan: plan,
      },
    }));
  }

  res.json({ task: state.currentTask.toJSON() });
});

app.post('/api/task/:id/cancel', (req, res) => {
  if (!state.currentTask || state.currentTask.id !== req.params.id) {
    return res.status(404).json({ error: 'Task not found' });
  }

  if (state.vmAgent) {
    state.vmAgent.send(JSON.stringify({
      type: 'cancel_task',
      payload: { task_id: state.currentTask.id },
    }));
  }

  state.currentTask.status = 'cancelled';
  state.currentTask.completedAt = new Date().toISOString();
  state.taskHistory.unshift(state.currentTask);

  const cancelled = state.currentTask;
  state.currentTask = null;

  res.json({ task: cancelled.toJSON() });
});

// Serve the UI
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// Start Server
// ============================================================================

server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║           AI Computer Agent - Host Controller              ║
╠════════════════════════════════════════════════════════════╣
║                                                            ║
║  Web UI:        http://localhost:${PORT}                     ║
║  VM Agent:      ws://localhost:${PORT}/agent                 ║
║                                                            ║
║  Waiting for VM agent to connect...                        ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});
