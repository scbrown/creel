/* The frame's behaviour: echoes the note into its own output element, so a
 * bridge test can prove the action landed INSIDE the frame. */
'use strict';

document.getElementById('save').addEventListener('click', () => {
  document.getElementById('note-out').textContent = 'Saved: ' + document.getElementById('note').value;
});
