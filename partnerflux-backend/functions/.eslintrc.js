module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  rules: {
    "quotes": ["error", "double"],
    // ★★★ 1行の最大文字数ルールを無効化 ★★★
    "max-len": "off",
  },
  parserOptions: {
    "ecmaVersion": 2020,
  },
};
