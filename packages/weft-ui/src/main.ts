import { mount } from 'svelte';

import App from './app/app.svelte';
import './styles/index.css';

const target = document.getElementById('app');

if (!target) {
  throw new Error('weft-ui: #app mount element not found in index.html');
}

mount(App, { target });
