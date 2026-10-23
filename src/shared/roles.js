// Canonical ARIA-aligned role mapping. SINGLE SOURCE for both consumers:
//   - src/browser/snapshot/page-script.js (embeds computeRoleSource into the
//     injected snapshot program)
//   - src/runtime/selectors.js (embeds computeRoleSource into the in-page
//     locator resolver, so snapshot-emitted `loc=role:...` locators resolve)
// computeRole must stay fully self-contained: it is re-evaluated inside pages
// via Function#toString, so no references to module scope or imports.
// Any change here must keep test/roles.test.mjs (round-trip) green.
export function computeRole(el) {
  const INPUT_TYPE_ROLE = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
  };
  const roleAttr = el.getAttribute ? (el.getAttribute('role') || '').trim() : '';
  if (roleAttr) return roleAttr.split(/\s+/)[0].toLowerCase(); // explicit role wins
  switch (el.tagName ? el.tagName.toLowerCase() : '') {
    case 'a':
    case 'area': return el.hasAttribute('href') ? 'link' : 'generic';
    case 'button': return 'button';
    case 'input':
      return INPUT_TYPE_ROLE[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox';
    case 'textarea': return 'textbox';
    case 'select': {
      const size = parseInt(el.getAttribute('size') || '0', 10);
      return (el.multiple || size > 1) ? 'listbox' : 'combobox';
    }
    case 'option': return 'option';
    case 'img':
    case 'canvas':
    case 'svg': return 'img';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': return 'heading';
    case 'ul':
    case 'ol': return 'list';
    case 'li': return 'listitem';
    case 'table': return 'table';
    case 'tr': return 'row';
    case 'td': return 'cell';
    case 'th': return 'columnheader';
    case 'nav': return 'navigation';
    case 'main': return 'main';
    case 'header': return 'banner';
    case 'footer': return 'contentinfo';
    case 'aside': return 'complementary';
    case 'form': return 'form';
    case 'dialog': return 'dialog';
    case 'iframe': return 'iframe';
    case 'progress': return 'progressbar';
    case 'summary': return 'button';
    default: return 'generic';
  }
}

// Embeddable source for injected scripts.
export const computeRoleSource = computeRole.toString();
