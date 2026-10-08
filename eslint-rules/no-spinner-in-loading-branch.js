// Loading states render skeletons, not spinners. A spinner-like component
// (Spinner, LoaderCircle, Loader2, ...) must not sit in the branch taken while
// an isLoading / isPending / status === 'pending' condition is true.
export const SPINNER_COMPONENT = /spinner|loader/i;

const LOADING_FLAGS = new Set(['isLoading', 'isPending']);

const isLoadingFlag = (node) =>
  (node.type === 'Identifier' && LOADING_FLAGS.has(node.name))
  || (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && LOADING_FLAGS.has(node.property.name));

const isPendingStatus = (node) =>
  node.type === 'BinaryExpression' && ['===', '=='].includes(node.operator)
  && [node.left, node.right].some((side) => side.type === 'Literal' && side.value === 'pending')
  && [node.left, node.right].some((side) =>
    (side.type === 'Identifier' && side.name === 'status')
    || (side.type === 'MemberExpression' && !side.computed && side.property.type === 'Identifier' && side.property.name === 'status'));

// True when `test` being truthy means "loading": the flag itself, a status check,
// `&&` chains containing one, or `||` where every operand is one.
const impliesLoading = (test) => {
  if (isLoadingFlag(test) || isPendingStatus(test)) return true;
  if (test.type === 'LogicalExpression') {
    return test.operator === '&&'
      ? impliesLoading(test.left) || impliesLoading(test.right)
      : impliesLoading(test.left) && impliesLoading(test.right);
  }
  return false;
};

// True when `test` being falsy means "loading": `!isLoading` style guards whose else-branch loads.
const impliesLoadingWhenFalsy = (test) =>
  test.type === 'UnaryExpression' && test.operator === '!' && impliesLoading(test.argument);

const jsxName = (name) => (name.type === 'JSXIdentifier' ? name.name : name.type === 'JSXMemberExpression' ? name.property.name : null);

export default {
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { spinner: 'Use a skeleton, not <{{name}}>, in a loading branch.' },
  },
  create(context) {
    const findSpinners = (root, visit) => {
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node.type !== 'string') continue;
        if (node.type === 'JSXOpeningElement') {
          const name = jsxName(node.name);
          if (name && SPINNER_COMPONENT.test(name)) visit(node, name);
        }
        for (const key of Object.keys(node)) {
          if (key === 'parent') continue;
          const child = node[key];
          if (Array.isArray(child)) stack.push(...child);
          else if (child && typeof child.type === 'string') stack.push(child);
        }
      }
    };
    const check = (branch) => branch && findSpinners(branch, (node, name) => context.report({ node, messageId: 'spinner', data: { name } }));
    return {
      ConditionalExpression(node) {
        if (impliesLoading(node.test)) check(node.consequent);
        else if (impliesLoadingWhenFalsy(node.test)) check(node.alternate);
      },
      IfStatement(node) {
        if (impliesLoading(node.test)) check(node.consequent);
        else if (impliesLoadingWhenFalsy(node.test)) check(node.alternate);
      },
      LogicalExpression(node) {
        if (node.operator === '&&' && impliesLoading(node.left)) check(node.right);
      },
    };
  },
};
