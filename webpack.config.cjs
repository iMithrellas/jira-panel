const path = require('node:path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/module.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'module.js',
    library: { type: 'amd' },
    publicPath: 'auto',
    clean: true,
  },
  externals: [
    'react', 'react-dom', 'react/jsx-runtime',
    '@grafana/data', '@grafana/runtime', '@grafana/ui', '@emotion/css',
  ],
  module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: 'ts-loader' }] },
  resolve: { extensions: ['.ts', '.tsx', '.js'] },
  plugins: [new CopyPlugin({ patterns: [
    { from: 'src/plugin.json', to: 'plugin.json' },
    { from: 'src/img', to: 'img' },
    { from: 'README.md', to: 'README.md' },
  ] })],
  devtool: 'source-map',
};
