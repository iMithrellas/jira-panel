const path = require('node:path');
const { createHash } = require('node:crypto');
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
  ] }), {
    apply(compiler) {
      compiler.hooks.thisCompilation.tap('PluginBuildVersion', (compilation) => {
        compilation.hooks.processAssets.tap({
          name: 'PluginBuildVersion',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
        }, () => {
          const bundle = compilation.getAsset('module.js').source.buffer();
          const hash = createHash('sha256').update(bundle).digest('hex').slice(0, 12);
          const metadata = JSON.parse(compilation.getAsset('plugin.json').source.source().toString());
          // Grafana keys plugin requests by info.version, even after rebuilding module.js.
          metadata.info.version = `${metadata.info.version}+${hash}`;
          compilation.updateAsset('plugin.json', new compiler.webpack.sources.RawSource(JSON.stringify(metadata, null, 2) + '\n'));
        });
      });
    },
  }],
  devtool: 'source-map',
};
