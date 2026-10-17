const { marker } = await import('./nested.js');
document.getElementById('module').textContent = `Relative module + dynamic import: ${marker}`;
