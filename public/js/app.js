/**
 * Progressive enhancement only.
 *
 * Every feature on this site works with JavaScript disabled — navigation is a
 * checkbox, forms are plain POSTs, and validation is repeated on the server.
 * What follows is polish layered on top of a working page.
 */
(function () {
  'use strict';

  // ---- Password reveal toggle -------------------------------------------
  document.querySelectorAll('[data-password-toggle]').forEach(function (button) {
    button.addEventListener('click', function () {
      var input = document.getElementById(button.getAttribute('data-password-toggle'));
      if (!input) return;
      var revealed = input.type === 'text';
      input.type = revealed ? 'password' : 'text';
      button.textContent = revealed ? 'Show' : 'Hide';
      button.setAttribute('aria-label', revealed ? 'Show password' : 'Hide password');
      input.focus({ preventScroll: true });
    });
  });

  // ---- Password strength meter ------------------------------------------
  // Deliberately advisory. The server enforces the real rule (8+ chars, a
  // letter and a number) in services/auth.js — this only tells the user how
  // they are doing while typing.
  var LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];

  function score(value) {
    if (!value) return 0;
    var points = 0;
    if (value.length >= 8) points++;
    if (value.length >= 12) points++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) points++;
    if (/[0-9]/.test(value)) points++;
    if (/[^A-Za-z0-9]/.test(value)) points++;
    return Math.min(4, points);
  }

  document.querySelectorAll('[data-strength-for]').forEach(function (meter) {
    var input = document.getElementById(meter.getAttribute('data-strength-for'));
    if (!input) return;
    var label = meter.querySelector('.strength-label');

    input.addEventListener('input', function () {
      var value = score(input.value);
      meter.setAttribute('data-score', input.value ? String(value) : '0');
      if (label) label.textContent = input.value ? LABELS[value] : 'Use 8+ characters with a letter and a number.';
    });
  });

  // ---- Confirm-password match hint ---------------------------------------
  document.querySelectorAll('[data-match-for]').forEach(function (confirmInput) {
    var original = document.getElementById(confirmInput.getAttribute('data-match-for'));
    var hint = document.getElementById(confirmInput.id + '-hint');
    if (!original || !hint) return;

    function check() {
      if (!confirmInput.value) {
        hint.textContent = '';
        return;
      }
      var same = confirmInput.value === original.value;
      hint.textContent = same ? 'Passwords match.' : 'Passwords do not match yet.';
      hint.className = same ? 'help' : 'error-text';
    }
    confirmInput.addEventListener('input', check);
    original.addEventListener('input', check);
  });

  // ---- Seat-hold countdown ----------------------------------------------
  // Shows the customer how long their seat is reserved for. The authoritative
  // expiry lives on the server (releaseExpiredHolds); this is just the clock.
  document.querySelectorAll('[data-hold-minutes]').forEach(function (el) {
    var minutes = parseInt(el.getAttribute('data-hold-minutes'), 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    var deadline = Date.now() + minutes * 60000;

    function tick() {
      var left = deadline - Date.now();
      if (left <= 0) {
        el.textContent = 'expired';
        el.classList.add('is-expired');
        return;
      }
      var m = Math.floor(left / 60000);
      var s = Math.floor((left % 60000) / 1000);
      el.textContent = m + ':' + String(s).padStart(2, '0');
      window.setTimeout(tick, 1000);
    }
    tick();
  });

  // ---- Copy-to-clipboard for booking references --------------------------
  document.querySelectorAll('[data-copy]').forEach(function (button) {
    button.addEventListener('click', function () {
      var text = button.getAttribute('data-copy');
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(function () {
        var original = button.textContent;
        button.textContent = 'Copied';
        window.setTimeout(function () {
          button.textContent = original;
        }, 1600);
      });
    });
  });

  // ---- Guard against double-submitting a payment -------------------------
  document.querySelectorAll('form[data-once]').forEach(function (form) {
    form.addEventListener('submit', function () {
      var button = form.querySelector('button[type="submit"]');
      if (!button) return;
      button.setAttribute('aria-disabled', 'true');
      button.dataset.label = button.textContent;
      button.textContent = button.getAttribute('data-busy') || 'Working…';
      // Re-enable if the user comes back via the browser's back button.
      window.setTimeout(function () {
        button.removeAttribute('aria-disabled');
        if (button.dataset.label) button.textContent = button.dataset.label;
      }, 12000);
    });
  });

  // ---- Auto-submit filter selects ----------------------------------------
  document.querySelectorAll('[data-autosubmit]').forEach(function (control) {
    control.addEventListener('change', function () {
      if (control.form) control.form.submit();
    });
  });
})();
