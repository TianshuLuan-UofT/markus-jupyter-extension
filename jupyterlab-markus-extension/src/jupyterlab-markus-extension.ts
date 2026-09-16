// Import Jupyter Front End components
import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';

// Import Command components
import { ICommandPalette, showDialog, Dialog } from '@jupyterlab/apputils';

// Getting JupyterLab coreutils
import { PageConfig } from '@jupyterlab/coreutils';

// Getting notebook components
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';

// Import to get toolbar button
import { ToolbarButton } from '@jupyterlab/apputils';

// Import for the trusted-origins setting
import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { Widget } from '@lumino/widgets';

import {
  fetchAvailableAssignments,
  IMarkUsCourse,
  MarkUsServerError,
  extractErrorMessage,
  getJupyterCredentials,
  getOrCreateSession,
  invalidateSession
} from './session';

// Declaring necessary variables
const ACTION_PREFIX = 'markus';
const ACTION_NAME = 'markus_submit';
const COMMAND_ID = `${ACTION_PREFIX}:${ACTION_NAME}`;
const SUBMIT_LABEL = 'Submit to MarkUs';
const PLUGIN_ID = 'jupyterlab-markus-extension:plugin';
const MARKUS_URL_KEY = 'markusUrl';
const TRUSTED_ORIGINS_KEY = 'trustedOrigins';

// MarkUs submission target.
export interface IMarkUsTarget {
  url: string;
  course_id: number;
  course: string;
  assignment_id: number;
  assignment: string;
}

// Creating the Payload space
interface ISubmitPayload {
  notebook_path: string;

  course_id?: number | string;
  course?: string;
  assignment_id?: number | string;
  assignment?: string;

  jupyter: {
    base_url: string;
    token: string;
  };

  session_token: string;
}

// Creating the submission response space
interface ISubmitResponse {
  status: string;
  message?: string;
  submitted_file?: string;
  markus_target?: {
    course_id?: number | string;
    course?: string;
    assignment_id?: number | string;
    assignment?: string;
    markus_user_name?: string;
  };
}

// Checking to see if a notebook is open
export function getCurrentNotebookPanel(tracker: INotebookTracker): NotebookPanel {
  const panel = tracker.currentWidget;

  if (!panel) {
    throw new Error('No active notebook is open.');
  }

  return panel;
}

// Normalize MarkUs URL so it can safely be used as a base URL.
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error('MarkUs URL cannot be blank.');
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`MarkUs server URL is not valid: "${trimmed}".`);
  }

  // Ensure url.pathname ends in a '/'
  url.pathname = url.pathname.replace(/\/?$/, '/');

  return url.toString();
}

// Read the trusted-origins setting, filtering out malformed entries.
export function getTrustedOrigins(
  settings: ISettingRegistry.ISettings
): string[] {
  const value = settings.get(TRUSTED_ORIGINS_KEY).composite;

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.trim().length > 0
  );
}

export function getMarkusUrl(settings: ISettingRegistry.ISettings): string {
  const value = settings.get(MARKUS_URL_KEY).composite;

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      'No MarkUs server URL is configured. Set "MarkUs server URL" in Settings > Settings Editor > Submit to MarkUs.'
    );
  }

  return normalizeBaseUrl(value);
}

// Reject submission targets that are not explicitly trusted.
export function assertTrustedOrigin(url: string, trustedOrigins: string[]): void {
  const origin = new URL(url).origin;

  if (trustedOrigins.length === 0) {
    throw new Error(
      'No trusted MarkUs origins are configured. Ask a JupyterLab administrator to add this MarkUs URL to the "Submit to MarkUs" settings (Settings > Settings Editor > Submit to MarkUs) before submitting.'
    );
  }

  if (!trustedOrigins.includes(origin)) {
    throw new Error(
      `MarkUs origin "${origin}" is not trusted. Trusted origins: ${trustedOrigins.join(
        ', '
      )}. Ask a JupyterLab administrator to add it to the "Submit to MarkUs" settings if this is expected.`
    );
  }
}

// Get notebook name from JupyterLab context.
export function getNotebookName(panel: NotebookPanel): string {
  const notebookName = panel.context.contentsModel?.name || panel.context.path.split('/').pop();

  if (!notebookName) {
    throw new Error('Could not determine notebook name. Please ensure the notebook is saved.');
  }

  return notebookName;
}

// Compiling the submission payload
export function buildSubmitPayload(
  panel: NotebookPanel,
  markus: IMarkUsTarget,
  sessionToken: string
): ISubmitPayload {
  const notebookPath = panel.context.path;

  if (!notebookPath) {
    throw new Error('Could not determine notebook path.');
  }

  return {
    notebook_path: notebookPath,

    course_id: markus.course_id,
    course: markus.course,
    assignment_id: markus.assignment_id,
    assignment: markus.assignment,

    jupyter: getJupyterCredentials(),

    session_token: sessionToken
  };
}

// Sending the submission request to the MarkUs server
async function submitToServer(
  payload: ISubmitPayload,
  markus: IMarkUsTarget
): Promise<ISubmitResponse> {
  const submitUrl = new URL('jupyter/submit', markus.url).toString();

  const response = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new MarkUsServerError(
      `MarkUs server error ${response.status}: ${extractErrorMessage(response.status, text)}`,
      response.status
    );
  }

  try {
    return JSON.parse(text) as ISubmitResponse;
  } catch {
    return {
      status: 'ok',
      message: text
    };
  }
}

// Submits with a valid session token, re-authenticating and retrying exactly
// once if the session was rejected (expired/tampered/wrong origin/etc).
export async function submitWithSessionRetry(
  panel: NotebookPanel,
  markus: IMarkUsTarget
): Promise<ISubmitResponse> {
  const sessionToken = await getOrCreateSession(markus.url);

  try {
    const payload = buildSubmitPayload(panel, markus, sessionToken);
    return await submitToServer(payload, markus);
  } catch (error) {
    if (!(error instanceof MarkUsServerError) || error.status !== 401) {
      throw error;
    }

    invalidateSession(markus.url);
    const freshSessionToken = await getOrCreateSession(markus.url);
    return await submitToServer(buildSubmitPayload(panel, markus, freshSessionToken), markus);
  }
}

// Confirming the submission is successful
async function reportSuccess(result: ISubmitResponse): Promise<void> {
  let body = result.message || 'Your file has been submitted successfully.';

  if (result.submitted_file) {
    body += `\n\nSubmitted file: ${result.submitted_file}`;
  }

  if (result.markus_target?.assignment) {
    body += `\n\nAssignment: ${result.markus_target.assignment}`;
  }

  if (result.markus_target?.markus_user_name) {
    body += `\n\nSubmitted as: ${result.markus_target.markus_user_name}`;
  }

  await showDialog({
    title: SUBMIT_LABEL,
    body,
    buttons: [Dialog.okButton({ label: 'Close' })]
  });
}

async function selectSubmissionTarget(
  markusUrl: string
): Promise<IMarkUsTarget | null> {
  const response = await fetchAvailableAssignments(markusUrl);

  const courses = response.courses.filter(
    (course: IMarkUsCourse) => course.assignments.length > 0
  );

  if (courses.length === 0) {
    throw new Error(
      'No MarkUs courses with available Jupyter-enabled assignments were found.'
    );
  }

  const node = document.createElement('div');

  const logo = document.createElement('div');
  logo.className = 'markus-dialog-logo';
  logo.setAttribute('role', 'img');
  logo.setAttribute('aria-label', 'MarkUs');
  node.appendChild(logo);

  const intro = document.createElement('p');
  intro.textContent = 'Choose where to submit this notebook.';
  node.appendChild(intro);

  const courseLabel = document.createElement('label');
  courseLabel.textContent = 'Course';
  courseLabel.style.display = 'block';
  courseLabel.style.marginBottom = '4px';
  node.appendChild(courseLabel);

  const courseSelect = document.createElement('select');
  courseSelect.style.width = '100%';
  courseSelect.style.marginBottom = '12px';
  node.appendChild(courseSelect);

  const assignmentLabel = document.createElement('label');
  assignmentLabel.textContent = 'Assignment';
  assignmentLabel.style.display = 'block';
  assignmentLabel.style.marginBottom = '4px';
  node.appendChild(assignmentLabel);

  const assignmentSelect = document.createElement('select');
  assignmentSelect.style.width = '100%';
  node.appendChild(assignmentSelect);

  for (const course of courses) {
    const option = document.createElement('option');
    option.value = String(course.id);
    option.textContent = course.display_name
      ? `${course.name} — ${course.display_name}`
      : course.name;
    courseSelect.appendChild(option);
  }

  const populateAssignments = (): void => {
    assignmentSelect.replaceChildren();

    const selectedCourse = courses.find(
      course => course.id === Number(courseSelect.value)
    );

    if (!selectedCourse) {
      return;
    }

    for (const assignment of selectedCourse.assignments) {
      const option = document.createElement('option');
      option.value = String(assignment.id);
      option.textContent = assignment.description
        ? `${assignment.short_identifier} — ${assignment.description}`
        : assignment.short_identifier;

      assignmentSelect.appendChild(option);
    }
  };

  courseSelect.addEventListener('change', populateAssignments);
  populateAssignments();

  const result = await showDialog({
    title: SUBMIT_LABEL,
    body: new Widget({ node }),
    buttons: [
      Dialog.cancelButton(),
      Dialog.okButton({ label: 'Continue' })
    ]
  });

  if (!result.button.accept) {
    return null;
  }

  const selectedCourse = courses.find(
    course => course.id === Number(courseSelect.value)
  );

  if (!selectedCourse) {
    throw new Error('The selected MarkUs course could not be found.');
  }

  const selectedAssignment = selectedCourse.assignments.find(
    assignment => assignment.id === Number(assignmentSelect.value)
  );

  if (!selectedAssignment) {
    throw new Error('The selected MarkUs assignment could not be found.');
  }

  return {
    url: markusUrl,
    course_id: selectedCourse.id,
    course: selectedCourse.name,
    assignment_id: selectedAssignment.id,
    assignment: selectedAssignment.short_identifier
  };
}

function createConfirmationBody(
  notebookName: string,
  markus: IMarkUsTarget
): Widget {
  const courseLabel = markus.course;
  const assignmentLabel = markus.assignment;

  const node = document.createElement('div');

  const intro = document.createElement('p');
  intro.textContent = 'Submit this notebook to MarkUs?';
  node.appendChild(intro);

  const username = PageConfig.getOption('hubUser') || '(not available)';

  const list = document.createElement('ul');
  const items: Array<[string, string]> = [
    ['Notebook', notebookName],
    ['MarkUs URL', markus.url],
    ['Username', username],
    ['Course', courseLabel],
    ['Assignment', assignmentLabel]
  ];

  for (const [label, value] of items) {
    const item = document.createElement('li');

    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    item.appendChild(strong);
    item.appendChild(document.createTextNode(value));

    list.appendChild(item);
  }

  node.appendChild(list);

  return new Widget({ node });
}

async function confirmSubmission(
  notebookName: string,
  markus: IMarkUsTarget
): Promise<boolean> {
  const result = await showDialog({
    title: SUBMIT_LABEL,
    body: createConfirmationBody(notebookName, markus),
    buttons: [Dialog.cancelButton(), Dialog.okButton({ label: 'Submit' })]
  });

  return result.button.accept;
}

// Report any errors
async function reportError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  console.error(`[${SUBMIT_LABEL}]`, error);

  await showDialog({
    title: SUBMIT_LABEL,
    body: `[ERROR] Could not submit file to MarkUs. Cause: ${message}`,
    buttons: [Dialog.okButton({ label: 'Close' })]
  });
}

// Submitting the file to server
async function submitToMarkUs(tracker: INotebookTracker, settings: ISettingRegistry.ISettings): Promise<void> {
  try {
    const panel = getCurrentNotebookPanel(tracker);

    await panel.context.save();

    const markusUrl = getMarkusUrl(settings);
    assertTrustedOrigin(markusUrl, getTrustedOrigins(settings));

    const markus = await selectSubmissionTarget(markusUrl);

    if (!markus) {
      return;
    }
    if (!(await confirmSubmission(getNotebookName(panel), markus))) {
      return;
    }

    const result = await submitWithSessionRetry(panel, markus);

    await reportSuccess(result);
  } catch (error) {
    await reportError(error);
  }
}

// Adding the function as a toolbar button
function addToolbarButton(panel: NotebookPanel, app: JupyterFrontEnd): void {
  if (Array.from(panel.toolbar.names()).includes(COMMAND_ID)) {
    return;
  }

  const button = new ToolbarButton({
    label: SUBMIT_LABEL,
    tooltip: SUBMIT_LABEL,
    iconClass: 'markus-toolbar-icon',
    onClick: () => {
      void app.commands.execute(COMMAND_ID);
    }
  });

  panel.toolbar.insertItem(10, COMMAND_ID, button);
}

// Creating the Jupyter Frontend Plugin
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Submit the current notebook to MarkUs by asking MarkUs to fetch it from JupyterHub/Jupyter Server.',
  autoStart: true,
  requires: [INotebookTracker, ISettingRegistry],
  optional: [ICommandPalette],
  activate: async (
    app: JupyterFrontEnd,
    tracker: INotebookTracker,
    settingRegistry: ISettingRegistry,
    palette: ICommandPalette | null
  ) => {
    console.log('JupyterLab extension jupyterlab-markus-extension is activated.');

    // Detect presence of JupyterHub identity, which is required for this extension.
    const hasHubIdentity = Boolean(PageConfig.getOption('hubUser'));

    if (!hasHubIdentity) {
      console.warn(`[${SUBMIT_LABEL}] No JupyterHub identity found. The "Submit to MarkUs" button will not be shown.`);
    }

    const settings = await settingRegistry.load(PLUGIN_ID);

    app.commands.addCommand(COMMAND_ID, {
      label: SUBMIT_LABEL,
      caption: SUBMIT_LABEL,
      execute: async () => {
        await submitToMarkUs(tracker, settings);
      }
    });

    if (palette && hasHubIdentity) {
      palette.addItem({
        command: COMMAND_ID,
        category: 'MarkUs'
      });
    }

    if (hasHubIdentity) {
      tracker.widgetAdded.connect((_sender, panel) => {
        addToolbarButton(panel, app);
      });

      if (tracker.currentWidget) {
        addToolbarButton(tracker.currentWidget, app);
      }
    }
  }
};

export default plugin;
