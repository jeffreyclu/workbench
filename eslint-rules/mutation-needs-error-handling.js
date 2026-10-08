// Every useMutation must surface failure: pass `onError`, or route the options
// through a helper that does. Add new wrappers to this one list.
export const MUTATION_ERROR_WRAPPERS = ['withMutationErrorToast'];

const calleeName = (callee) =>
  callee.type === 'Identifier' ? callee.name
    : callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' ? callee.property.name
      : null;

const isWrapperCall = (node) =>
  node?.type === 'CallExpression' && MUTATION_ERROR_WRAPPERS.includes(calleeName(node.callee));

const hasOnError = (objectNode) =>
  objectNode.properties.some((property) =>
    property.type === 'Property' && !property.computed
    && (property.key.name === 'onError' || property.key.value === 'onError'));

export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missing: 'useMutation needs an onError handler (toast the failure) or must be wrapped by one of: {{wrappers}}.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (calleeName(node.callee) !== 'useMutation') return;
        if (isWrapperCall(node.parent)) return;
        const options = node.arguments[0];
        if (isWrapperCall(options)) return;
        if (options?.type === 'ObjectExpression' && hasOnError(options)) return;
        context.report({ node, messageId: 'missing', data: { wrappers: MUTATION_ERROR_WRAPPERS.join(', ') } });
      },
    };
  },
};
