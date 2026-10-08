import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import mutationNeedsErrorHandling from './mutation-needs-error-handling.js';
import noSpinnerInLoadingBranch from './no-spinner-in-loading-branch.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

tester.run('mutation-needs-error-handling', mutationNeedsErrorHandling, {
  valid: [
    'const m = useMutation({ mutationFn: f, onError: (e) => toastError("x", e) });',
    'const m = useMutation({ mutationFn: f, onError });',
    'const m = useMutation(withMutationErrorToast({ mutationFn: f }));',
    'const m = withMutationErrorToast(useMutation({ mutationFn: f }));',
    'const m = useQuery({ queryFn: f });',
  ],
  invalid: [
    { code: 'const m = useMutation({ mutationFn: f });', errors: [{ messageId: 'missing' }] },
    { code: 'const m = useMutation({ mutationFn: f, onSuccess });', errors: [{ messageId: 'missing' }] },
    { code: 'const m = useMutation(options);', errors: [{ messageId: 'missing' }] },
    { code: 'const m = rq.useMutation({ mutationFn: f });', errors: [{ messageId: 'missing' }] },
    { code: 'const m = otherHelper(useMutation({ mutationFn: f }));', errors: [{ messageId: 'missing' }] },
  ],
});

tester.run('no-spinner-in-loading-branch', noSpinnerInLoadingBranch, {
  valid: [
    'const a = isLoading ? <Skeleton /> : <List />;',
    'const a = isPending && <Skeleton />;',
    'const a = !isLoading ? <List /> : <Skeleton />;',
    'const a = ready ? <LoaderCircle /> : null;',
    'const a = isLoading ? <Skeleton /> : <Spinner />;',
    'const a = q.status === "success" ? <Spinner /> : null;',
  ],
  invalid: [
    { code: 'const a = isLoading ? <Spinner /> : <List />;', errors: [{ messageId: 'spinner' }] },
    { code: 'const a = save.isPending ? <LoaderCircle size={13} /> : <Save />;', errors: [{ messageId: 'spinner' }] },
    { code: 'const a = query.isLoading && <Loader2 />;', errors: [{ messageId: 'spinner' }] },
    { code: 'const a = !isLoading ? <List /> : <div><Spinner /></div>;', errors: [{ messageId: 'spinner' }] },
    { code: 'const a = q.status === "pending" ? <Spinner /> : null;', errors: [{ messageId: 'spinner' }] },
    { code: 'function C() { if (isPending) { return <Icons.Spinner />; } return null; }', errors: [{ messageId: 'spinner' }] },
  ],
});
