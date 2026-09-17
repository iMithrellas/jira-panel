import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import CopyWebpackPlugin from 'copy-webpack-plugin';
import webpack, { type Configuration } from 'webpack';

type BuildEnv = { production?: boolean };

const root = process.cwd();
const packageMetadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const pluginMetadata = JSON.parse(readFileSync(path.join(root, 'src', 'plugin.json'), 'utf8')) as { id: string };
const pluginMetadataPath = path.join(root, 'src', 'plugin.json');
const sourceRoot = path.join(root, 'src');

const externals: Configuration['externals'] = [
  '@emotion/css',
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  /^@grafana\/data/,
  /^@grafana\/runtime/,
  /^@grafana\/ui/,
];

class PluginMetadataWebpackPlugin {
  apply(compiler: webpack.Compiler) {
    compiler.hooks.thisCompilation.tap('PluginMetadataWebpackPlugin', (compilation) => {
      compilation.hooks.processAssets.tap({
        name: 'PluginMetadataWebpackPlugin',
        stage: webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
      }, () => {
        const bundle = compilation.getAsset('module.js')?.source.buffer();
        const pluginJson = compilation.getAsset('plugin.json');
        if (!bundle || !pluginJson) { return; }
        const metadata = JSON.parse(pluginJson.source.source().toString());
        const hash = createHash('sha256').update(bundle).digest('hex').slice(0, 12);
        const releaseBuild = process.env.GRAFANA_PLUGIN_RELEASE === 'true';
        // Development builds use a content hash to invalidate Grafana's plugin cache.
        metadata.info.version = releaseBuild ? packageMetadata.version : `${packageMetadata.version}+${hash}`;
        metadata.info.updated = new Date().toISOString().slice(0, 10);
        compilation.updateAsset(
          'plugin.json',
          new webpack.sources.RawSource(JSON.stringify(metadata, null, 2) + '\n')
        );
      });
    });
  }
}

export default (env: BuildEnv = {}): Configuration => ({
  mode: env.production ? 'production' : 'development',
  entry: './src/module.ts',
  devtool: env.production ? 'source-map' : 'eval-source-map',
  externals,
  module: {
    rules: [{
      test: /\.tsx?$/,
      exclude: /node_modules/,
      use: {
        loader: 'swc-loader',
        options: {
          sourceMaps: true,
          jsc: {
            target: 'es2022',
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic' } },
          },
        },
      },
    }],
  },
  output: {
    path: path.join(root, 'dist'),
    filename: 'module.js',
    library: { type: 'amd' },
    publicPath: 'auto',
    clean: true,
    devtoolModuleFilenameTemplate: ({ absoluteResourcePath }) => {
      const relativePath = path.relative(sourceRoot, absoluteResourcePath).split(path.sep).join('/');
      const sourcePath = relativePath.startsWith('../node_modules/')
        ? relativePath
        : relativePath.replace(/^\.\.\//, '');
      return `webpack://${pluginMetadata.id}/${sourcePath}`;
    },
  },
  plugins: [
    new CopyWebpackPlugin({ patterns: [
      { from: pluginMetadataPath, to: 'plugin.json' },
      { from: 'src/img', to: 'img' },
      { from: 'README.md', to: 'README.md' },
      { from: 'LICENSE', to: 'LICENSE', toType: 'file' },
      { from: 'CHANGELOG.md', to: 'CHANGELOG.md' },
    ] }),
    new PluginMetadataWebpackPlugin(),
  ],
  resolve: { extensions: ['.ts', '.tsx', '.js'] },
});
