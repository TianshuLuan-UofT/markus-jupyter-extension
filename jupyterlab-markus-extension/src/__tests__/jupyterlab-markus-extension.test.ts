// These modules are heavy JupyterLab framework packages that the module
// under test only needs a handful of runtime values from (mostly Token
// objects used for dependency injection); mocking them keeps these tests
// fast, dependency-free unit tests of the pure(ish) validation/formatting
// logic, rather than integration tests against real JupyterLab internals.
jest.mock('@jupyterlab/application', () => ({}));
jest.mock('@jupyterlab/apputils', () => ({
  ICommandPalette: {},
  Dialog: { okButton: jest.fn(), cancelButton: jest.fn() },
  showDialog: jest.fn(),
  ToolbarButton: jest.fn()
}));
jest.mock('@jupyterlab/coreutils', () => ({
  PageConfig: {
    getBaseUrl: jest.fn(),
    getToken: jest.fn()
  }
}));
jest.mock('@jupyterlab/notebook', () => ({
  INotebookTracker: {}
}));
jest.mock('@jupyterlab/settingregistry', () => ({
  ISettingRegistry: {}
}));
// Real @lumino/widgets pulls in @lumino/dragdrop, which references the
// browser's `DragEvent` global -- unavailable in this jsdom version. Not
// used by anything under test (only by the confirmation dialog's body,
// which isn't exported/unit-tested), so a bare stand-in is enough.
jest.mock('@lumino/widgets', () => ({
  Widget: jest.fn()
}));

import { PageConfig } from '@jupyterlab/coreutils';
import type { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import type { ISettingRegistry } from '@jupyterlab/settingregistry';

import {
  assertTrustedOrigin,
  buildSubmitPayload,
  getCurrentNotebookPanel,
  getNotebookName,
  getTrustedOrigins,
  normalizeBaseUrl,
  submitWithSessionRetry
} from '../jupyterlab-markus-extension';

import { invalidateSession } from '../session';

const mockGetBaseUrl = PageConfig.getBaseUrl as jest.Mock;
const mockGetToken = PageConfig.getToken as jest.Mock;

function makeSettings(trustedOrigins: unknown): ISettingRegistry.ISettings {
  return {
    get: (key: string) => {
      if (key !== 'trustedOrigins') {
        throw new Error(`Unexpected settings key requested in test: "${key}"`);
      }
      return { composite: trustedOrigins };
    }
  } as unknown as ISettingRegistry.ISettings;
}

function makePanel(
  options: {
    path?: string | null;
    contentsModelName?: string;
    metadata?: unknown;
  } = {}
): NotebookPanel {
  const path = options.path === undefined ? 'notebooks/demo.ipynb' : options.path;

  return {
    context: {
      path,
      contentsModel: options.contentsModelName ? { name: options.contentsModelName } : null
    },
    content: {
      model: {
        metadata: options.metadata
      }
    }
  } as unknown as NotebookPanel;
}

describe('normalizeBaseUrl', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeBaseUrl('  http://localhost:3000/  ')).toBe('http://localhost:3000/');
  });

  it('throws on a blank value', () => {
    expect(() => normalizeBaseUrl('   ')).toThrow('MarkUs URL cannot be blank.');
  });

  it('throws a friendly error on an invalid URL', () => {
    expect(() => normalizeBaseUrl('not-a-url')).toThrow(/MarkUs server URL is not valid/);
  });

  it('appends a trailing slash when missing', () => {
    expect(normalizeBaseUrl('http://localhost:3000')).toBe('http://localhost:3000/');
  });

  it('leaves an existing trailing slash alone', () => {
    expect(normalizeBaseUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
  });

  it('preserves a sub-path while adding the trailing slash', () => {
    expect(normalizeBaseUrl('http://localhost:3000/csc108')).toBe('http://localhost:3000/csc108/');
  });
});

describe('assertTrustedOrigin', () => {
  it('does not throw when the origin is trusted', () => {
    expect(() =>
      assertTrustedOrigin('https://markus.example.com/csc108/', ['https://markus.example.com'])
    ).not.toThrow();
  });

  it('matches on origin only, ignoring path differences', () => {
    expect(() =>
      assertTrustedOrigin('https://markus.example.com/some/deep/path', ['https://markus.example.com'])
    ).not.toThrow();
  });

  it('throws a specific message when no origins are trusted at all', () => {
    expect(() => assertTrustedOrigin('https://markus.example.com/', [])).toThrow(
      'No trusted MarkUs origins are configured.'
    );
  });

  it('throws naming the untrusted origin when the list is non-empty', () => {
    expect(() => assertTrustedOrigin('https://evil.example.com/', ['https://markus.example.com'])).toThrow(
      /MarkUs origin "https:\/\/evil\.example\.com" is not trusted/
    );
  });
});

describe('getTrustedOrigins', () => {
  it('returns configured origins and filters out invalid entries', () => {
    const settings = makeSettings([
      'https://markus.example.com',
      42,
      null,
      '',
      '   '
    ]);

    expect(getTrustedOrigins(settings)).toEqual([
      'https://markus.example.com'
    ]);
  });

  it('returns an empty array when the setting is not an array', () => {
    const settings = makeSettings(undefined);

    expect(getTrustedOrigins(settings)).toEqual([]);
  });
});

describe('getCurrentNotebookPanel', () => {
  it('returns the current widget when a notebook is open', () => {
    const panel = makePanel();
    const tracker = { currentWidget: panel } as unknown as INotebookTracker;

    expect(getCurrentNotebookPanel(tracker)).toBe(panel);
  });

  it('throws when no notebook is open', () => {
    const tracker = { currentWidget: null } as unknown as INotebookTracker;

    expect(() => getCurrentNotebookPanel(tracker)).toThrow('No active notebook is open.');
  });
});

describe('getNotebookName', () => {
  it('prefers the contents model name', () => {
    const panel = makePanel({ path: 'nested/demo.ipynb', contentsModelName: 'demo.ipynb' });
    expect(getNotebookName(panel)).toBe('demo.ipynb');
  });

  it('falls back to the last path segment', () => {
    const panel = makePanel({ path: 'nested/demo.ipynb' });
    expect(getNotebookName(panel)).toBe('demo.ipynb');
  });

  it('throws when neither is available', () => {
    const panel = makePanel({ path: '' });
    expect(() => getNotebookName(panel)).toThrow('Could not determine notebook name.');
  });
});

describe('buildSubmitPayload', () => {
  const markus = {
    url: 'http://localhost:3000/',
    course_id: 1,
    course: 'csc108',
    assignment_id: 2,
    assignment: 'A1'
  };

  beforeEach(() => {
    mockGetBaseUrl.mockReset().mockReturnValue('http://localhost:8888/');
    mockGetToken.mockReset().mockReturnValue('test-token');
  });

  it('throws when the notebook path is unavailable', () => {
    const panel = makePanel({ path: '' });
    expect(() => buildSubmitPayload(panel, markus, 'session-token')).toThrow('Could not determine notebook path.');
  });

  it('throws when no Jupyter token is available', () => {
    mockGetToken.mockReturnValue('');
    const panel = makePanel({ path: 'demo.ipynb', contentsModelName: 'demo.ipynb' });

    expect(() => buildSubmitPayload(panel, markus, 'session-token')).toThrow('No Jupyter token available.');
  });

  it('assembles the full payload from the panel, MarkUs target, PageConfig, and session token', () => {
    const panel = makePanel({ path: 'nested/demo.ipynb', contentsModelName: 'demo.ipynb' });

    expect(buildSubmitPayload(panel, markus, 'session-token')).toEqual({
      notebook_path: 'nested/demo.ipynb',
      course_id: 1,
      course: 'csc108',
      assignment_id: 2,
      assignment: 'A1',
      jupyter: {
        base_url: 'http://localhost:8888/',
        token: 'test-token'
      },
      session_token: 'session-token'
    });
  });
});

describe('submitWithSessionRetry', () => {
  const markus = {
    url: 'http://retry.example.com/',
    course_id: 1,
    course: 'csc108',
    assignment_id: 2,
    assignment: 'A1'
  };

  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockGetBaseUrl.mockReset().mockReturnValue('http://localhost:8888/');
    mockGetToken.mockReset().mockReturnValue('test-token');
    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;
    invalidateSession(markus.url);
  });

  function authResponse(sessionToken: string): { ok: true; status: 200; text: () => Promise<string> } {
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          status: 'success',
          session_token: sessionToken,
          expires_at: new Date(Date.now() + 60_000).toISOString()
        })
    };
  }

  function submitSuccess(): { ok: true; status: 200; text: () => Promise<string> } {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'success', submitted_file: 'demo.ipynb' })
    };
  }

  function submitUnauthorized(): { ok: false; status: 401; text: () => Promise<string> } {
    return {
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ status: 'error', message: 'Session expired.', error_class: 'IdentityError' })
    };
  }

  it('authenticates then submits on the happy path', async () => {
    const panel = makePanel({ path: 'demo.ipynb', contentsModelName: 'demo.ipynb' });
    mockFetch
      .mockResolvedValueOnce(authResponse('sess-1'))
      .mockResolvedValueOnce(submitSuccess());

    const result = await submitWithSessionRetry(panel, markus);

    expect(result.submitted_file).toBe('demo.ipynb');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('re-authenticates and retries exactly once on a 401, succeeding the second time', async () => {
    const panel = makePanel({ path: 'demo.ipynb', contentsModelName: 'demo.ipynb' });
    mockFetch
      .mockResolvedValueOnce(authResponse('sess-1'))
      .mockResolvedValueOnce(submitUnauthorized())
      .mockResolvedValueOnce(authResponse('sess-2'))
      .mockResolvedValueOnce(submitSuccess());

    const result = await submitWithSessionRetry(panel, markus);

    expect(result.submitted_file).toBe('demo.ipynb');
    expect(mockFetch).toHaveBeenCalledTimes(4);

    const secondSubmitBody = JSON.parse((mockFetch.mock.calls[3][1] as RequestInit).body as string);
    expect(secondSubmitBody.session_token).toBe('sess-2');
  });

  it('propagates the error if the retried submit also fails with a 401', async () => {
    const panel = makePanel({ path: 'demo.ipynb', contentsModelName: 'demo.ipynb' });
    mockFetch
      .mockResolvedValueOnce(authResponse('sess-1'))
      .mockResolvedValueOnce(submitUnauthorized())
      .mockResolvedValueOnce(authResponse('sess-2'))
      .mockResolvedValueOnce(submitUnauthorized());

    await expect(submitWithSessionRetry(panel, markus)).rejects.toMatchObject({
      name: 'MarkUsServerError',
      status: 401
    });
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('does not retry on a non-401 failure', async () => {
    const panel = makePanel({ path: 'demo.ipynb', contentsModelName: 'demo.ipynb' });
    mockFetch.mockResolvedValueOnce(authResponse('sess-1')).mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ status: 'error', message: 'Not a student in this course.' })
    });

    await expect(submitWithSessionRetry(panel, markus)).rejects.toMatchObject({
      name: 'MarkUsServerError',
      status: 403
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
