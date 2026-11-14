// The feature files in specs/features are the behaviour spec; steps/ is the
// glue. Strict: an undefined or pending step fails the run.
export default {
  paths: ["specs/features/**/*.feature"],
  import: ["steps/**/*.ts"],
  format: ["progress"],
  strict: true,
  publish: false,
};
