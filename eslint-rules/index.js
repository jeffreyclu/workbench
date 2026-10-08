import mutationNeedsErrorHandling from './mutation-needs-error-handling.js';
import noSpinnerInLoadingBranch from './no-spinner-in-loading-branch.js';

export default {
  rules: {
    'mutation-needs-error-handling': mutationNeedsErrorHandling,
    'no-spinner-in-loading-branch': noSpinnerInLoadingBranch,
  },
};
