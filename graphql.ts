// GraphQL (`POST /api/graphql`): a small parser and executor for the query
// language subset the suite uses — operations with variables, aliases, inline
// fragments, named fragments, input objects and lists — over the same store
// as the REST API. Batching (a JSON array body) is supported; each element
// answers in order. An unknown field is a validation error: HTTP 200 with an
// `errors` array naming the field and `data: null`. An unknown repository is
// `data.repository = null` with no errors.

import { jsonResult, parseJsonBody, isRecord, type HandlerResult } from './httputil.ts';
import {
  commentGid,
  decodeGid,
  issueGid,
  nowIso,
  pullGid,
  repoGid,
  type Forge,
  type Issue,
  type Item,
  type Pull,
  type Repo,
} from './store.ts';
import { VIEWER } from './scenario.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < source.length) {
        const c = source[j] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            value += map[esc] ?? esc;
            j += 2;
          }
          continue;
        }
        value += c;
        j += 1;
      }
      if (!closed) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in query`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST and parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'StringValue'; value: string }
  | { kind: 'IntValue'; value: number }
  | { kind: 'FloatValue'; value: number }
  | { kind: 'BooleanValue'; value: boolean }
  | { kind: 'NullValue' }
  | { kind: 'EnumValue'; value: string }
  | { kind: 'ListValue'; values: ValueNode[] }
  | { kind: 'ObjectValue'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentDefinition {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentDefinition>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}", got "${token.value}"`);
    return token.value;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = token.value;
      this.next();
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value;
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.parseVariableDefinitions();
    }
    this.parseDirectives();
    return { operation, name, selectionSet: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.matchPunct('=')) this.parseValue();
    }
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value;
        this.parseDirectives();
        return { kind: 'FragmentSpread', name };
      }
      this.parseDirectives();
      return { kind: 'InlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.matchPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') args = this.parseArguments();
    this.parseDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'Field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.matchPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'IntValue', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'FloatValue', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'StringValue', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'BooleanValue', value: true };
      if (token.value === 'false') return { kind: 'BooleanValue', value: false };
      if (token.value === 'null') return { kind: 'NullValue' };
      return { kind: 'EnumValue', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.matchPunct(']')) values.push(this.parseValue());
      return { kind: 'ListValue', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'ObjectValue', fields };
    }
    throw new Error(`unexpected token ${token.kind} where a value was expected`);
  }
}

// ---------------------------------------------------------------------------------------------
// schema (field -> return type) for validation and introspection
// ---------------------------------------------------------------------------------------------

const SCHEMA: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { login: 'String', id: 'ID', name: 'String', email: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'String', body: 'String', createdAt: 'String', updatedAt: 'String' },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PageInfo: { hasNextPage: 'Boolean', endCursor: 'String', hasPreviousPage: 'Boolean', startCursor: 'String' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    merged: 'Boolean',
    headRefName: 'String',
    baseRefName: 'String',
    mergeable: 'String',
    files: 'PullRequestChangedFileConnection',
  },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  Node: { id: 'ID' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String' },
  __EnumValue: { name: 'String' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { id: 'ID', body: 'String' },
};

const ENUM_TYPES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
};

function baseTypeName(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

function validateSelections(
  selections: readonly SelectionNode[],
  parentType: string,
  fragments: ReadonlyMap<string, FragmentDefinition>,
  errors: Array<{ message: string }>,
): void {
  for (const selection of selections) {
    if (selection.kind === 'InlineFragment') {
      validateSelections(selection.selectionSet, selection.typeCondition ?? parentType, fragments, errors);
    } else if (selection.kind === 'FragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment "${selection.name}".` });
      } else {
        validateSelections(fragment.selectionSet, fragment.typeCondition, fragments, errors);
      }
    } else {
      if (selection.name === '__typename') continue;
      const fields = SCHEMA[parentType];
      const returnType = fields?.[selection.name];
      if (returnType === undefined) {
        errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".` });
        continue;
      }
      if (selection.selectionSet !== null) {
        validateSelections(selection.selectionSet, baseTypeName(returnType), fragments, errors);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface Wrapper {
  readonly __typename: string;
  readonly data: unknown;
}

function wrap(typename: string, data: unknown): Wrapper {
  return { __typename: typename, data };
}

interface ExecContext {
  readonly forge: Forge;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fragments: ReadonlyMap<string, FragmentDefinition>;
  readonly errors: Array<{ message: string; path?: string[] }>;
}

function resolveValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name] ?? null;
    case 'StringValue':
    case 'IntValue':
    case 'FloatValue':
    case 'BooleanValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return node.value;
    case 'ListValue':
      return node.values.map((v) => resolveValue(v, variables));
    case 'ObjectValue': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

function findRepoById(forge: Forge, dbId: number): Repo | undefined {
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return undefined;
}

function cursorFor(seq: number): string {
  return Buffer.from(`c:${seq}`, 'utf8').toString('base64');
}

function cursorSeq(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^c:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface PageInfoData {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly startCursor: string | null;
}

function pageItems<T extends { seq: number }>(
  items: readonly T[],
  first: unknown,
  after: unknown,
  descending: boolean,
): { nodes: T[]; pageInfo: PageInfoData } {
  const sorted = [...items].sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  const afterSeq = cursorSeq(after);
  const filtered = afterSeq === null
    ? sorted
    : sorted.filter((item) => (descending ? item.seq < afterSeq : item.seq > afterSeq));
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, first) : filtered.length;
  const nodes = filtered.slice(0, limit);
  const last = nodes.length > 0 ? (nodes[nodes.length - 1] as T) : null;
  const firstItem = nodes.length > 0 ? (nodes[0] as T) : null;
  return {
    nodes,
    pageInfo: {
      hasNextPage: filtered.length > nodes.length,
      endCursor: last === null ? null : cursorFor(last.seq),
      startCursor: firstItem === null ? null : cursorFor(firstItem.seq),
    },
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findComment(forge: Forge, repoDbId: number, commentId: number): { repo: Repo; item: Item; comment: { id: number; body: string } } | null {
  const repo = findRepoById(forge, repoDbId);
  if (repo === undefined) return null;
  const items: Item[] = [...repo.issues.values(), ...repo.pulls.values()];
  for (const item of items) {
    const comment = item.comments.find((c) => c.id === commentId);
    if (comment !== undefined) return { repo, item, comment };
  }
  return null;
}

function resolveField(parentType: string, parent: unknown, field: FieldNode, ctx: ExecContext): unknown {
  const args = argsOf(field, ctx);
  const forge = ctx.forge;
  switch (parentType) {
    case 'Query': {
      if (field.name === 'viewer') return wrap('User', VIEWER);
      if (field.name === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== VIEWER.login) return null;
        return forge.getRepo(owner, name) === undefined ? null : wrap('Repository', forge.getRepo(owner, name) as Repo);
      }
      if (field.name === 'node') {
        const decoded = decodeGid(args.id as string);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoById(forge, decoded.repoDbId);
          return repo === undefined ? null : wrap('Repository', repo);
        }
        if (decoded.kind === 'Issue') {
          const repo = findRepoById(forge, decoded.repoDbId);
          const issue = repo?.issues.get(decoded.number);
          return issue === undefined ? null : wrap('Issue', issue);
        }
        if (decoded.kind === 'PullRequest') {
          const repo = findRepoById(forge, decoded.repoDbId);
          const pull = repo?.pulls.get(decoded.number);
          return pull === undefined ? null : wrap('PullRequest', pull);
        }
        if (decoded.kind === 'IssueComment') {
          const found = findComment(forge, decoded.repoDbId, decoded.commentId);
          return found === null ? null : wrap('IssueComment', { comment: found.comment, repoDbId: decoded.repoDbId });
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name as string;
        if (SCHEMA[name] !== undefined || ENUM_TYPES[name] !== undefined || name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID') {
          return wrap('__Type', { name });
        }
        return null;
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = args.input as Record<string, unknown>;
        const decoded = decodeGid(input.repositoryId as string);
        const repo = decoded?.kind === 'Repository' ? findRepoById(forge, decoded.repoDbId) : undefined;
        if (repo === undefined) {
          ctx.errors.push({ message: 'Repository not found' });
          return null;
        }
        const created = forge.createIssue(repo, (input.title as string) ?? '', (input.body as string) ?? '', []);
        if ('error' in created) {
          ctx.errors.push({ message: created.error });
          return null;
        }
        return wrap('CreateIssuePayload', { issue: created });
      }
      if (field.name === 'closeIssue') {
        const input = args.input as Record<string, unknown>;
        const decoded = decodeGid(input.issueId as string);
        const repo = decoded !== null && (decoded.kind === 'Issue' || decoded.kind === 'PullRequest')
          ? findRepoById(forge, decoded.repoDbId)
          : undefined;
        const issue = decoded?.kind === 'Issue' ? repo?.issues.get(decoded.number) : undefined;
        if (repo === undefined || issue === undefined) {
          ctx.errors.push({ message: 'Issue not found' });
          return null;
        }
        issue.state = 'closed';
        issue.closedAt = nowIso();
        issue.updatedAt = issue.closedAt;
        return wrap('CloseIssuePayload', { issue });
      }
      if (field.name === 'createPullRequest') {
        const input = args.input as Record<string, unknown>;
        const decoded = decodeGid(input.repositoryId as string);
        const repo = decoded?.kind === 'Repository' ? findRepoById(forge, decoded.repoDbId) : undefined;
        if (repo === undefined) {
          ctx.errors.push({ message: 'Repository not found' });
          return null;
        }
        const created = forge.createPull(
          repo,
          (input.title as string) ?? '',
          (input.body as string) ?? '',
          input.headRefName as string,
          input.baseRefName as string,
        );
        if ('error' in created) {
          ctx.errors.push({ message: created.error });
          return null;
        }
        return wrap('CreatePullRequestPayload', { pullRequest: created });
      }
      if (field.name === 'mergePullRequest') {
        const input = args.input as Record<string, unknown>;
        const decoded = decodeGid(input.pullRequestId as string);
        const repo = decoded?.kind === 'PullRequest' ? findRepoById(forge, decoded.repoDbId) : undefined;
        const pull = decoded?.kind === 'PullRequest' ? repo?.pulls.get(decoded.number) : undefined;
        if (repo === undefined || pull === undefined) {
          ctx.errors.push({ message: 'Pull request not found' });
          return null;
        }
        const method = ((input.mergeMethod as string) ?? 'SQUASH').toLowerCase();
        const result = forge.mergePull(repo, pull, method);
        if ('conflict' in result) {
          ctx.errors.push({ message: 'Pull request has conflicts' });
          return null;
        }
        if ('error' in result) {
          ctx.errors.push({ message: result.error });
          return null;
        }
        return wrap('MergePullRequestPayload', { pullRequest: pull });
      }
      if (field.name === 'addComment') {
        const input = args.input as Record<string, unknown>;
        const decoded = decodeGid(input.subjectId as string);
        const repo = decoded !== null && decoded.kind !== 'Repository' && decoded.kind !== 'IssueComment'
          ? findRepoById(forge, decoded.repoDbId)
          : undefined;
        const item = decoded?.kind === 'Issue'
          ? repo?.issues.get(decoded.number)
          : decoded?.kind === 'PullRequest'
            ? repo?.pulls.get(decoded.number)
            : undefined;
        if (repo === undefined || item === undefined) {
          ctx.errors.push({ message: 'Subject not found' });
          return null;
        }
        const comment = forge.addComment(item, (input.body as string) ?? '');
        return wrap('AddCommentPayload', { comment, repoDbId: repo.id });
      }
      return null;
    }
    case 'User': {
      const user = parent as typeof VIEWER;
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return Buffer.from(`User:${user.id}`, 'utf8').toString('base64');
      if (field.name === 'name') return user.name;
      if (field.name === 'email') return user.email;
      return null;
    }
    case 'Repository': {
      const repo = parent as Repo;
      if (field.name === 'id') return repoGid(repo.id);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return wrap('User', VIEWER);
      if (field.name === 'defaultBranchRef') return wrap('Ref', { name: repo.defaultBranch });
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const issue = repo.issues.get(args.number as number);
        return issue === undefined ? null : wrap('Issue', issue);
      }
      if (field.name === 'issues') {
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : null;
        const descending = orderBy?.direction === 'DESC';
        let items = [...repo.issues.values()];
        if (states !== null) {
          items = items.filter((i) => states.includes(issueState(i)));
        }
        const page = pageItems(items, args.first, args.after, descending);
        return wrap('IssueConnection', page);
      }
      if (field.name === 'pullRequests') {
        const page = pageItems([...repo.pulls.values()], args.first, args.after, false);
        return wrap('PullRequestConnection', page);
      }
      if (field.name === 'pullRequest') {
        const pull = repo.pulls.get(args.number as number);
        return pull === undefined ? null : wrap('PullRequest', pull);
      }
      return null;
    }
    case 'Ref': {
      const ref = parent as { name: string };
      if (field.name === 'name') return ref.name;
      return null;
    }
    case 'Issue': {
      const issue = parent as Issue;
      if (field.name === 'id') return issueGid(issue.repoDbId, issue.number);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issueState(issue);
      if (field.name === 'body') return issue.body;
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      return null;
    }
    case 'IssueConnection': {
      const page = parent as { nodes: Issue[]; pageInfo: PageInfoData };
      if (field.name === 'nodes') return page.nodes.map((i) => wrap('Issue', i));
      if (field.name === 'pageInfo') return wrap('PageInfo', page.pageInfo);
      if (field.name === 'totalCount') return page.nodes.length;
      return null;
    }
    case 'PullRequestConnection': {
      const page = parent as { nodes: Pull[]; pageInfo: PageInfoData };
      if (field.name === 'nodes') return page.nodes.map((p) => wrap('PullRequest', p));
      if (field.name === 'pageInfo') return wrap('PageInfo', page.pageInfo);
      if (field.name === 'totalCount') return page.nodes.length;
      return null;
    }
    case 'PageInfo': {
      const info = parent as PageInfoData;
      if (field.name === 'hasNextPage') return info.hasNextPage;
      if (field.name === 'endCursor') return info.endCursor;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return info.startCursor;
      return null;
    }
    case 'PullRequest': {
      const pull = parent as Pull;
      if (field.name === 'id') return pullGid(pull.repoDbId, pull.number);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pullState(pull);
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'mergeable') {
        const repo = findRepoById(forge, pull.repoDbId);
        return repo === undefined ? 'UNKNOWN' : forge.prMergeable(repo, pull);
      }
      if (field.name === 'files') {
        const repo = findRepoById(forge, pull.repoDbId);
        const files = repo === undefined ? [] : forge.prFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first);
        return wrap('PullRequestChangedFileConnection', {
          nodes,
          pageInfo: { hasNextPage: files.length > nodes.length, endCursor: null, startCursor: null },
        });
      }
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      const page = parent as { nodes: Array<{ filename: string; additions: number; deletions: number; status: string }>; pageInfo: PageInfoData };
      if (field.name === 'nodes') return page.nodes.map((f) => wrap('PullRequestChangedFile', f));
      if (field.name === 'pageInfo') return wrap('PageInfo', page.pageInfo);
      if (field.name === 'totalCount') return page.nodes.length;
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = parent as { filename: string; additions: number; deletions: number; status: string };
      if (field.name === 'path') return file.filename;
      if (field.name === 'additions') return file.additions;
      if (field.name === 'deletions') return file.deletions;
      if (field.name === 'changeType') {
        return file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED';
      }
      return null;
    }
    case 'Node': {
      const node = parent as { id?: string };
      if (field.name === 'id') return node.id ?? null;
      return null;
    }
    case '__Type': {
      const type = parent as { name: string };
      if (field.name === 'name') return type.name;
      if (field.name === 'kind') {
        if (ENUM_TYPES[type.name] !== undefined) return 'ENUM';
        if (type.name === 'Node') return 'INTERFACE';
        if (type.name === 'String' || type.name === 'Int' || type.name === 'Boolean' || type.name === 'ID') return 'SCALAR';
        return 'OBJECT';
      }
      if (field.name === 'fields') {
        const fields = SCHEMA[type.name];
        if (fields === undefined) return null;
        return Object.keys(fields).map((name) => wrap('__Field', { name }));
      }
      if (field.name === 'enumValues') {
        const values = ENUM_TYPES[type.name];
        if (values === undefined) return null;
        return values.map((name) => wrap('__EnumValue', { name }));
      }
      return null;
    }
    case '__Field': {
      const f = parent as { name: string };
      if (field.name === 'name') return f.name;
      return null;
    }
    case '__EnumValue': {
      const v = parent as { name: string };
      if (field.name === 'name') return v.name;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = parent as { issue: Issue };
      if (field.name === 'issue') return wrap('Issue', payload.issue);
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = parent as { pullRequest: Pull };
      if (field.name === 'pullRequest') return wrap('PullRequest', payload.pullRequest);
      return null;
    }
    case 'AddCommentPayload': {
      const payload = parent as { comment: { id: number; body: string }; repoDbId: number };
      if (field.name === 'commentEdge') return wrap('IssueCommentEdge', payload);
      return null;
    }
    case 'IssueCommentEdge': {
      const edge = parent as { comment: { id: number; body: string }; repoDbId: number };
      if (field.name === 'node') return wrap('IssueComment', edge);
      return null;
    }
    case 'IssueComment': {
      const c = parent as { comment: { id: number; body: string }; repoDbId: number };
      if (field.name === 'id') return commentGid(c.repoDbId, c.comment.id);
      if (field.name === 'body') return c.comment.body;
      return null;
    }
    default:
      return null;
  }
}

function executeSelectionSet(
  selections: readonly SelectionNode[],
  parentType: string,
  parent: unknown,
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(out, executeSelectionSet(selection.selectionSet, parentType, parent, ctx));
      continue;
    }
    if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== parentType) continue;
      Object.assign(out, executeSelectionSet(fragment.selectionSet, parentType, parent, ctx));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    const value = resolveField(parentType, parent, selection, ctx);
    if (selection.selectionSet === null) {
      out[key] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          const wrapper = item as Wrapper;
          return executeSelectionSet(selection.selectionSet as SelectionNode[], wrapper.__typename, wrapper.data, ctx);
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      const wrapper = value as Wrapper;
      out[key] = executeSelectionSet(selection.selectionSet, wrapper.__typename, wrapper.data, ctx);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function executeOne(
  forge: Forge,
  request: { query?: unknown; variables?: unknown; operationName?: unknown },
): Record<string, unknown> {
  if (typeof request.query !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
  }
  const variables = isRecord(request.variables) ? (request.variables as Record<string, unknown>) : {};
  let operation: OperationNode | undefined;
  if (typeof request.operationName === 'string') {
    operation = document.operations.find((op) => op.name === request.operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${request.operationName}".` }] };
    }
  } else {
    operation = document.operations[0];
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const errors: Array<{ message: string; path?: string[] }> = [];
  validateSelections(operation.selectionSet, rootType, document.fragments, errors);
  if (errors.length > 0) return { data: null, errors };
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors };
  const data = executeSelectionSet(operation.selectionSet, rootType, null, ctx);
  const result: Record<string, unknown> = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

export function handleGraphql(forge: Forge, body: Buffer): HandlerResult {
  const parsed = parseJsonBody(body);
  if (parsed === null) return jsonResult(400, { message: 'Invalid JSON body' });
  if (Array.isArray(parsed)) {
    const results = parsed.map((element) => (isRecord(element) ? executeOne(forge, element) : { data: null, errors: [{ message: 'Must provide query string.' }] }));
    return jsonResult(200, results);
  }
  if (!isRecord(parsed)) return jsonResult(400, { message: 'Invalid GraphQL request' });
  return jsonResult(200, executeOne(forge, parsed));
}
