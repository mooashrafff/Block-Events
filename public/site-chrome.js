(function () {
  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function navMatchForHref(href) {
    var u = String(href || '').trim();
    if (!u || u === '/') return '/';
    try {
      var p = new URL(u, window.location.origin).pathname;
      return p.replace(/\/$/, '') || '/';
    } catch (e) {
      return u.split('?')[0].replace(/\/$/, '') || '/';
    }
  }

  var ICON = {
    home: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/></svg>',
    events:
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
    tickets:
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"/></svg>',
    contact:
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>',
    about:
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    profile:
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>',
    auth:
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"/></svg>',
    link: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/></svg>',
    menu:
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg>',
    faq:
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
  };

  var SOCIAL_ORDER = ['facebook', 'linkedin', 'instagram', 'twitter', 'youtube', 'tiktok'];
  var SOCIAL_ICON = {
    facebook:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
    linkedin:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>',
    instagram:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"/></svg>',
    twitter:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    youtube:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
    tiktok:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/></svg>',
  };

  function socialRowShown(row) {
    if (!row || typeof row !== 'object') return false;
    var v = row.visible;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return true;
  }

  function socialUrlMap(c) {
    var m = {};
    (Array.isArray(c && c.socialLinks) ? c.socialLinks : []).forEach(function (row) {
      if (!row || !row.id) return;
      if (!socialRowShown(row)) return;
      var u = String(row.url || '').trim();
      if (!u) return;
      m[String(row.id).toLowerCase()] = u;
    });
    return m;
  }

  function socialLabelMap(c) {
    var m = {};
    (Array.isArray(c && c.socialLinks) ? c.socialLinks : []).forEach(function (row) {
      if (!row || !row.id) return;
      if (!socialRowShown(row)) return;
      if (!String(row.url || '').trim()) return;
      m[String(row.id).toLowerCase()] = String(row.label || row.id).trim();
    });
    return m;
  }

  function buildSocialClusterHtml(c, kind) {
    var urls = socialUrlMap(c);
    var labels = socialLabelMap(c);
    var cls =
      kind === 'header'
        ? 'site-chrome-social__link site-chrome-social__link--header'
        : 'site-chrome-social__link site-chrome-social__link--footer';
    return SOCIAL_ORDER.filter(function (id) {
      return urls[id];
    })
      .map(function (id) {
        var svg = SOCIAL_ICON[id] || ICON.link;
        var label = labels[id] || id;
        return (
          '<a class="' +
          cls +
          '" data-social-id="' +
          escapeHtml(id) +
          '" href="' +
          escapeHtml(urls[id]) +
          '" target="_blank" rel="noopener noreferrer" aria-label="' +
          escapeHtml(label) +
          '"><span class="site-chrome-social__icon" aria-hidden="true">' +
          svg +
          '</span></a>'
        );
      })
      .join('');
  }

  function fillHeaderSocialFromConfig(c) {
    var html = buildSocialClusterHtml(c, 'header');
    document.querySelectorAll('.site-chrome-header__social').forEach(function (host) {
      host.innerHTML = html;
      host.style.display = html ? '' : 'none';
    });
  }

  function fillFooterSocialFromConfig(c) {
    var html = buildSocialClusterHtml(c, 'footer');
    document.querySelectorAll('.site-chrome-footer__social-slot, .site-chrome-footer__left').forEach(function (slot) {
      var host = slot.querySelector('.site-chrome-footer__social');
      if (!host) {
        host = document.createElement('div');
        host.className = 'site-chrome-footer__social';
        host.setAttribute('aria-label', 'Social links');
        slot.appendChild(host);
      }
      host.innerHTML = html;
      host.style.display = html ? '' : 'none';
    });
  }

  function applyDataBlockSocial(c) {
    var urls = socialUrlMap(c);
    var labels = socialLabelMap(c);
    document.querySelectorAll('[data-block-social]').forEach(function (a) {
      var id = (a.getAttribute('data-block-social') || '').toLowerCase().trim();
      var url = urls[id];
      if (url) {
        a.setAttribute('href', url);
        a.hidden = false;
        a.removeAttribute('aria-hidden');
        var lbl = labels[id];
        if (lbl) a.setAttribute('aria-label', lbl);
      } else {
        a.setAttribute('href', '#');
        a.hidden = true;
        a.setAttribute('aria-hidden', 'true');
      }
    });
  }

  function iconForUrlAndLabel(url, label) {
    var m = navMatchForHref(url).toLowerCase();
    var t = String(label || '').toLowerCase();
    if (m === '/' || t === 'home') return ICON.home;
    if (m === '/events' || m.indexOf('/event') === 0 || t.indexOf('event') >= 0) return ICON.events;
    if (m.indexOf('/my-tickets') === 0 || t.indexOf('ticket') >= 0) return ICON.tickets;
    if (m.indexOf('/contact') === 0 || t.indexOf('contact') >= 0) return ICON.contact;
    if (m === '/faq' || t.indexOf('faq') >= 0) return ICON.faq;
    if (m.indexOf('/about') === 0 || t === 'about' || t.indexOf('about') >= 0) return ICON.about;
    if (m.indexOf('/profile') === 0 || t === 'account') return ICON.profile;
    if (m.indexOf('/auth') === 0 || t.indexOf('sign') >= 0) return ICON.auth;
    return ICON.link;
  }

  var LANG_STORAGE_KEY = 'block_site_lang';
  var langDocumentCloseBound = false;

  var CHROME_NAV_AR = {
    '/': 'الرئيسية',
    '/events': 'الفعاليات',
    '/my-tickets': 'تذاكري',
    '/contact': 'اتصل بنا',
    '/about-us': 'من نحن',
    '/faq': 'الأسئلة الشائعة',
  };

  var CHROME_SOCIAL_ARIA_AR = {
    facebook: 'فيسبوك',
    linkedin: 'لينكد إن',
    instagram: 'إنستغرام',
    twitter: 'إكس (تويتر)',
    youtube: 'يوتيوب',
    tiktok: 'تيك توك',
  };

  function getChromeLang() {
    try {
      if (localStorage.getItem(LANG_STORAGE_KEY) === 'ar') return 'ar';
    } catch (e) {}
    return document.documentElement.lang === 'ar' ? 'ar' : 'en';
  }

  function navArabicLabelForMatch(m) {
    if (!m) return null;
    if (CHROME_NAV_AR[m]) return CHROME_NAV_AR[m];
    if (m.indexOf('/event') === 0) return CHROME_NAV_AR['/events'];
    return null;
  }

  function applyChromeNavI18n(lang) {
    document.querySelectorAll('.site-chrome-navlink__label').forEach(function (span) {
      var a = span.closest('a');
      if (!a) return;
      var en = span.getAttribute('data-chrome-label-en');
      if (!en) {
        en = span.textContent.trim();
        span.setAttribute('data-chrome-label-en', en);
      }
      var m = a.getAttribute('data-nav-match');
      if (lang === 'ar') {
        var t = navArabicLabelForMatch(m);
        span.textContent = t || en;
      } else {
        span.textContent = en;
      }
    });
  }

  function applyChromeAccountI18n(lang) {
    document.querySelectorAll('.site-chrome-header__account-link').forEach(function (el) {
      if (!el.getAttribute('data-chrome-label-en')) {
        el.setAttribute('data-chrome-label-en', el.textContent.trim() || 'Account');
      }
      el.textContent = '';
      el.setAttribute('aria-label', lang === 'ar' ? 'الحساب' : el.getAttribute('data-chrome-label-en'));
    });
    document.querySelectorAll('.site-chrome-header__signin').forEach(function (el) {
      if (!el.getAttribute('data-chrome-label-en')) {
        el.setAttribute('data-chrome-label-en', el.textContent.trim() || 'Sign in');
      }
      el.textContent = '';
      el.setAttribute('aria-label', lang === 'ar' ? 'تسجيل الدخول' : el.getAttribute('data-chrome-label-en'));
    });
    document.querySelectorAll('.site-chrome-header__signout').forEach(function (el) {
      if (!el.getAttribute('data-chrome-label-en')) {
        el.setAttribute('data-chrome-label-en', el.textContent.trim() || 'Sign out');
      }
      el.textContent = '';
      el.setAttribute('aria-label', lang === 'ar' ? 'تسجيل الخروج' : el.getAttribute('data-chrome-label-en'));
    });
  }

  function applyChromeSocialAriaI18n(lang) {
    document.querySelectorAll('.site-chrome-social__link[data-social-id]').forEach(function (a) {
      var id = (a.getAttribute('data-social-id') || '').toLowerCase();
      if (!a.getAttribute('data-chrome-aria-en')) {
        a.setAttribute('data-chrome-aria-en', a.getAttribute('aria-label') || id);
      }
      var en = a.getAttribute('data-chrome-aria-en');
      if (lang === 'ar' && CHROME_SOCIAL_ARIA_AR[id]) {
        a.setAttribute('aria-label', CHROME_SOCIAL_ARIA_AR[id]);
      } else {
        a.setAttribute('aria-label', en);
      }
    });
  }

  function applyChromeMiscAriaI18n(lang) {
    document.querySelectorAll('.site-chrome-header__social').forEach(function (el) {
      if (!el.getAttribute('data-chrome-aria-en')) {
        el.setAttribute('data-chrome-aria-en', el.getAttribute('aria-label') || 'Social links');
      }
      el.setAttribute('aria-label', lang === 'ar' ? 'روابط التواصل' : el.getAttribute('data-chrome-aria-en'));
    });
    document.querySelectorAll('.site-chrome-footer__social').forEach(function (el) {
      if (!el.getAttribute('data-chrome-aria-en')) {
        el.setAttribute('data-chrome-aria-en', el.getAttribute('aria-label') || 'Social links');
      }
      el.setAttribute('aria-label', lang === 'ar' ? 'روابط التواصل' : el.getAttribute('data-chrome-aria-en'));
    });
    document.querySelectorAll('.site-chrome-lang__btn').forEach(function (btn) {
      if (!btn.getAttribute('data-chrome-aria-en')) {
        btn.setAttribute('data-chrome-aria-en', btn.getAttribute('aria-label') || 'Choose language');
      }
      btn.setAttribute('aria-label', lang === 'ar' ? 'اختر اللغة' : btn.getAttribute('data-chrome-aria-en'));
    });
    document.querySelectorAll('.site-chrome-header__logo-wrap').forEach(function (el) {
      if (!el.getAttribute('data-chrome-aria-en')) {
        el.setAttribute('data-chrome-aria-en', el.getAttribute('aria-label') || 'BLOCK Home');
      }
      el.setAttribute('aria-label', lang === 'ar' ? 'الصفحة الرئيسية – BLOCK' : el.getAttribute('data-chrome-aria-en'));
    });
    document.querySelectorAll('nav.site-chrome-nav--header, nav.site-chrome-nav--footer').forEach(function (nav) {
      var cur = nav.getAttribute('aria-label');
      if (!nav.getAttribute('data-chrome-aria-en')) {
        nav.setAttribute('data-chrome-aria-en', cur || 'Main');
      }
      var en = nav.getAttribute('data-chrome-aria-en');
      if (nav.classList.contains('site-chrome-nav--footer')) {
        nav.setAttribute('aria-label', lang === 'ar' ? 'تذييل الصفحة' : en);
      } else {
        nav.setAttribute('aria-label', lang === 'ar' ? 'التنقل الرئيسي' : en);
      }
    });
  }

  function applyDataBlockSocialI18n(lang) {
    document.querySelectorAll('[data-block-social]').forEach(function (a) {
      if (a.hidden) return;
      var id = (a.getAttribute('data-block-social') || '').toLowerCase();
      if (!id) return;
      if (!a.getAttribute('data-chrome-aria-en')) {
        a.setAttribute('data-chrome-aria-en', a.getAttribute('aria-label') || id);
      }
      var en = a.getAttribute('data-chrome-aria-en');
      if (lang === 'ar' && CHROME_SOCIAL_ARIA_AR[id]) {
        a.setAttribute('aria-label', CHROME_SOCIAL_ARIA_AR[id]);
      } else {
        a.setAttribute('aria-label', en);
      }
    });
  }

  function applyChromeHeaderFooterI18n(lang) {
    applyChromeAccountI18n(lang);
    applyChromeNavI18n(lang);
    applyChromeSocialAriaI18n(lang);
    applyChromeMiscAriaI18n(lang);
    applyDataBlockSocialI18n(lang);
    syncSiteChromeMoreDrawerTitleI18n();
  }

  function applySiteLang(code) {
    var lang = code === 'ar' ? 'ar' : 'en';
    try {
      localStorage.setItem(LANG_STORAGE_KEY, lang);
    } catch (e) {}
    document.documentElement.lang = lang;
    document.body.classList.toggle('rtl', lang === 'ar');
    var labelText = lang === 'ar' ? 'العربية' : 'English';
    document.querySelectorAll('.site-chrome-lang__label').forEach(function (el) {
      el.textContent = labelText;
    });
    applyChromeHeaderFooterI18n(lang);
    updateTicketLoaderCopy();
    try {
      window.dispatchEvent(new CustomEvent('block:langchange', { detail: { lang: lang } }));
    } catch (e2) {}
  }

  function injectLanguageSwitcher() {
    /* Translate/languages glyph — avoids a circular “globe” beside the logo in RTL */
    var langIconSvg =
      '<svg class="site-chrome-lang__icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>';

    document.querySelectorAll('.site-chrome-header__top-inner').forEach(function (row) {
      if (row.querySelector('.site-chrome-header__utils')) return;
      var logo = row.querySelector('.site-chrome-header__logo-wrap');
      var account = row.querySelector('.site-chrome-header__account');
      var utils = document.createElement('div');
      utils.className = 'site-chrome-header__utils';
      var socialHost = document.createElement('div');
      socialHost.className = 'site-chrome-header__social';
      socialHost.setAttribute('aria-label', 'Social links');
      var langWrap = document.createElement('div');
      langWrap.className = 'site-chrome-lang';
      langWrap.innerHTML =
        '<button type="button" class="site-chrome-lang__btn" aria-haspopup="listbox" aria-expanded="false" aria-label="Choose language">' +
        langIconSvg +
        '<span class="site-chrome-lang__label">English</span>' +
        '<span class="site-chrome-lang__chev" aria-hidden="true">▼</span>' +
        '</button>' +
        '<ul class="site-chrome-lang__menu" role="listbox" hidden>' +
        '<li role="presentation"><button type="button" class="site-chrome-lang__option" data-lang="en">English</button></li>' +
        '<li role="presentation"><button type="button" class="site-chrome-lang__option" data-lang="ar">العربية</button></li>' +
        '</ul>';

      utils.appendChild(socialHost);
      if (account) {
        account.remove();
        utils.appendChild(account);
      }
      utils.appendChild(langWrap);
      while (row.firstChild) row.removeChild(row.firstChild);
      if (logo) row.appendChild(logo);
      row.appendChild(utils);

      var btn = langWrap.querySelector('.site-chrome-lang__btn');
      var menu = langWrap.querySelector('.site-chrome-lang__menu');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var willOpen = menu.hidden;
        document.querySelectorAll('.site-chrome-lang__menu').forEach(function (m) {
          m.hidden = true;
        });
        document.querySelectorAll('.site-chrome-lang__btn').forEach(function (b) {
          b.setAttribute('aria-expanded', 'false');
        });
        if (willOpen) {
          menu.hidden = false;
          btn.setAttribute('aria-expanded', 'true');
        }
      });
      langWrap.querySelectorAll('.site-chrome-lang__option').forEach(function (opt) {
        opt.addEventListener('click', function (e) {
          e.stopPropagation();
          var code = opt.getAttribute('data-lang') || 'en';
          applySiteLang(code);
          menu.hidden = true;
          btn.setAttribute('aria-expanded', 'false');
        });
      });
    });

    if (!langDocumentCloseBound) {
      langDocumentCloseBound = true;
      document.addEventListener('click', function () {
        document.querySelectorAll('.site-chrome-lang__menu').forEach(function (m) {
          m.hidden = true;
        });
        document.querySelectorAll('.site-chrome-lang__btn').forEach(function (b) {
          b.setAttribute('aria-expanded', 'false');
        });
      });
    }

    var stored = 'en';
    try {
      stored = localStorage.getItem(LANG_STORAGE_KEY) || 'en';
    } catch (e) {}
    applySiteLang(stored);
  }

  function splitHeaderDom() {
    document.querySelectorAll('.site-chrome-header').forEach(function (hdr) {
      var inner = hdr.querySelector('.site-chrome-header__inner');
      if (!inner || inner.getAttribute('data-chrome-v2') === '1') return;
      var logo = inner.querySelector('.site-chrome-header__logo-wrap');
      var nav = inner.querySelector('nav.site-chrome-nav--header');
      var account = inner.querySelector('.site-chrome-header__account');
      if (!logo && !nav && !account) return;
      inner.setAttribute('data-chrome-v2', '1');
      var top = document.createElement('div');
      top.className = 'site-chrome-header__top';
      var topIn = document.createElement('div');
      topIn.className = 'site-chrome-header__top-inner';
      if (logo) topIn.appendChild(logo);
      if (account) topIn.appendChild(account);
      top.appendChild(topIn);
      var band = document.createElement('div');
      band.className = 'site-chrome-header__nav-band';
      var navIn = document.createElement('div');
      navIn.className = 'site-chrome-header__nav-inner';
      if (nav) navIn.appendChild(nav);
      band.appendChild(navIn);
      inner.innerHTML = '';
      inner.appendChild(top);
      inner.appendChild(band);
    });
  }

  function splitFooterDom() {
    document.querySelectorAll('.site-chrome-footer__inner').forEach(function (inner) {
      if (inner.getAttribute('data-chrome-v3') === '1') return;
      var logo = inner.querySelector('.site-chrome-footer__logo-wrap');
      var nav = inner.querySelector('nav.site-chrome-nav--footer');
      var copy = inner.querySelector('.site-chrome-footer__copy');
      if (!logo && !nav && !copy) return;
      inner.setAttribute('data-chrome-v3', '1');
      inner.removeAttribute('data-chrome-v2');

      var top = document.createElement('div');
      top.className = 'site-chrome-footer__top';

      var brand = document.createElement('div');
      brand.className = 'site-chrome-footer__brand';
      if (logo) brand.appendChild(logo);

      var socialSlot = document.createElement('div');
      socialSlot.className = 'site-chrome-footer__social-slot';

      top.appendChild(brand);
      if (nav) top.appendChild(nav);
      top.appendChild(socialSlot);

      var rule = document.createElement('div');
      rule.className = 'site-chrome-footer__rule';
      rule.setAttribute('aria-hidden', 'true');

      inner.innerHTML = '';
      inner.appendChild(top);
      inner.appendChild(rule);
      if (copy) inner.appendChild(copy);
    });
  }

  function buildNavHtml(links, kind) {
    var cls = kind === 'footer' ? 'site-chrome-navlink site-chrome-navlink--footer' : 'site-chrome-navlink site-chrome-navlink--header';
    return (Array.isArray(links) ? links : [])
      .map(function (l) {
        var url = String((l && l.url) || '');
        var label = String((l && l.label) || '');
        var match = navMatchForHref(url);
        var svg = iconForUrlAndLabel(url, label);
        return (
          '<a class="' +
          cls +
          '" href="' +
          escapeHtml(url) +
          '" data-nav-match="' +
          escapeHtml(match) +
          '"><span class="site-chrome-navlink__icon" aria-hidden="true">' +
          svg +
          '</span><span class="site-chrome-navlink__label" data-chrome-label-en="' +
          escapeHtml(label) +
          '">' +
          escapeHtml(label) +
          '</span></a>'
        );
      })
      .join('');
  }

  function injectNavFromConfig(c) {
    var headerLinks = Array.isArray(c.headerLinks) && c.headerLinks.length ? c.headerLinks : c.links;
    var footerLinks = Array.isArray(c.footerLinks) && c.footerLinks.length ? c.footerLinks : c.links;
    if (!Array.isArray(headerLinks)) headerLinks = [];
    if (!Array.isArray(footerLinks)) footerLinks = [];

    var split = splitHeaderLinksForMobile(headerLinks);
    var hInner = buildStructuredHeaderNavInnerHtml(split.primary, split.overflow);
    var fHtml = buildNavHtml(footerLinks, 'footer');
    document.querySelectorAll('nav.site-chrome-nav--header').forEach(function (nav) {
      nav.innerHTML = hInner;
    });
    document.querySelectorAll('nav.site-chrome-nav--footer').forEach(function (nav) {
      nav.innerHTML = fHtml;
    });

    injectOrUpdateSiteChromeMoreDrawer(split.overflow);
    bindSiteChromeMoreDrawerUi();
    syncSiteChromeMoreDrawerTitleI18n();
  }

  function setNavActive() {
    var path = window.location.pathname.replace(/\/$/, '') || '/';
    document.querySelectorAll('[data-nav-match]').forEach(function (a) {
      var m = a.getAttribute('data-nav-match');
      a.classList.remove('is-active');
      if (!m) return;
      if (m === '/' && path === '/') a.classList.add('is-active');
      else if (
        m === '/events' &&
        (path === '/events' || path === '/event' || path.startsWith('/event/'))
      ) {
        a.classList.add('is-active');
      } else if (m !== '/' && m !== '/events' && (path === m || path.startsWith(m + '/'))) a.classList.add('is-active');
    });
  }

  function setCopyrightFromConfig(c) {
    var el = document.getElementById('siteChromeCopyright');
    if (!el) return;
    el.textContent = (c && c.copyright) || '© BLOCK. All rights reserved.';
  }

  function bindSessionChrome() {
    var signin = document.querySelector('.site-chrome-header__signin');
    var signout = document.getElementById('siteChromeSignOut');
    if (!signin && !signout) return;
    /* Do not use localStorage alone for has-session — it showed sign-out while logged out. */

    function setSignoutVisible(show) {
      if (!signout) return;
      if (show) {
        signout.hidden = false;
        signout.removeAttribute('aria-hidden');
      } else {
        signout.hidden = true;
        signout.setAttribute('aria-hidden', 'true');
      }
    }

    setSignoutVisible(false);

    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 503) return { user: null };
        return r.json();
      })
      .then(function (d) {
        if (d && d.user) {
          document.body.classList.add('has-session');
          setSignoutVisible(true);
          try {
            localStorage.setItem('block_home_signed_in', '1');
          } catch (e) {}
        } else {
          document.body.classList.remove('has-session');
          setSignoutVisible(false);
          try {
            localStorage.removeItem('block_home_signed_in');
          } catch (e) {}
        }
      })
      .catch(function () {
        document.body.classList.remove('has-session');
        setSignoutVisible(false);
        try {
          localStorage.removeItem('block_home_signed_in');
        } catch (e) {}
      });

    if (signout) {
      signout.addEventListener('click', function () {
        fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(function () {
          try {
            localStorage.removeItem('block_home_signed_in');
          } catch (e) {}
          window.location.href = '/';
        });
      });
    }
  }

  var DEFAULT_CHROME_LINKS = [
    { label: 'Home', url: '/' },
    { label: 'Events', url: '/events' },
    { label: 'My tickets', url: '/my-tickets' },
    { label: 'Contact & Support', url: '/contact' },
    { label: 'About Us', url: '/about-us' },
    { label: 'FAQ', url: '/faq' },
  ];

  /** Normalized paths that stay in the header row on small screens; everything else goes to the “More” drawer. */
  var MOBILE_HEADER_PRIMARY = { '/': true, '/events': true, '/my-tickets': true };

  function splitHeaderLinksForMobile(links) {
    var primary = [];
    var overflow = [];
    (Array.isArray(links) ? links : []).forEach(function (l) {
      if (!l || !(l.url || l.label)) return;
      var m = navMatchForHref(l.url);
      if (MOBILE_HEADER_PRIMARY[m]) primary.push(l);
      else overflow.push(l);
    });
    if (!primary.length && (links || []).length) {
      return { primary: links.slice(), overflow: [] };
    }
    return { primary: primary, overflow: overflow };
  }

  function buildStructuredHeaderNavInnerHtml(primary, overflow) {
    var primaryHtml = buildNavHtml(primary, 'header');
    var overflowHtml = buildNavHtml(overflow, 'header');
    var menuBtn =
      overflow.length > 0
        ? '<button type="button" class="site-chrome-header__more-menu" aria-label="More" aria-expanded="false" aria-controls="siteChromeMoreDrawer">' +
          ICON.menu +
          '</button>'
        : '';
    return (
      '<div class="site-chrome-nav__primary-row">' +
      menuBtn +
      '<div class="site-chrome-nav__primary-links">' +
      primaryHtml +
      '</div>' +
      '</div>' +
      '<div class="site-chrome-nav__overflow-desktop">' +
      overflowHtml +
      '</div>'
    );
  }

  function closeSiteChromeMoreDrawer() {
    document.body.classList.remove('site-chrome-more-open');
    var drawer = document.getElementById('siteChromeMoreDrawer');
    var backdrop = document.getElementById('siteChromeMoreBackdrop');
    if (drawer) {
      drawer.hidden = true;
      drawer.setAttribute('aria-hidden', 'true');
    }
    if (backdrop) {
      backdrop.hidden = true;
    }
    document.querySelectorAll('.site-chrome-header__more-menu').forEach(function (b) {
      b.setAttribute('aria-expanded', 'false');
    });
  }

  function openSiteChromeMoreDrawer() {
    var drawer = document.getElementById('siteChromeMoreDrawer');
    var backdrop = document.getElementById('siteChromeMoreBackdrop');
    if (!drawer || drawer.hidden === false) return;
    document.body.classList.add('site-chrome-more-open');
    if (backdrop) {
      backdrop.hidden = false;
    }
    drawer.hidden = false;
    drawer.setAttribute('aria-hidden', 'false');
    document.querySelectorAll('.site-chrome-header__more-menu').forEach(function (b) {
      b.setAttribute('aria-expanded', 'true');
    });
    try {
      var first = drawer.querySelector('a[href]');
      if (first) first.focus();
    } catch (e) {}
  }

  function injectOrUpdateSiteChromeMoreDrawer(overflowLinks) {
    var overflowHtml = buildNavHtml(Array.isArray(overflowLinks) ? overflowLinks : [], 'header');
    var backdrop = document.getElementById('siteChromeMoreBackdrop');
    var drawer = document.getElementById('siteChromeMoreDrawer');
    if (!overflowHtml) {
      if (backdrop) backdrop.remove();
      if (drawer) drawer.remove();
      closeSiteChromeMoreDrawer();
      return;
    }
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'siteChromeMoreBackdrop';
      backdrop.className = 'site-chrome-more-backdrop';
      backdrop.hidden = true;
      document.body.appendChild(backdrop);
    }
    if (!drawer) {
      drawer = document.createElement('aside');
      drawer.id = 'siteChromeMoreDrawer';
      drawer.className = 'site-chrome-more-drawer';
      drawer.setAttribute('aria-label', 'More navigation');
      drawer.hidden = true;
      drawer.innerHTML =
        '<div class="site-chrome-more-drawer__head">' +
        '<span class="site-chrome-more-drawer__title" data-chrome-more-title-en="More">More</span>' +
        '<button type="button" class="site-chrome-more-drawer__close" aria-label="Close menu">&times;</button>' +
        '</div>' +
        '<nav class="site-chrome-more-drawer__nav" aria-label="More"></nav>';
      document.body.appendChild(drawer);
    }
    var navHost = drawer.querySelector('.site-chrome-more-drawer__nav');
    if (navHost) navHost.innerHTML = overflowHtml;
  }

  function syncSiteChromeMoreDrawerTitleI18n() {
    var el = document.querySelector('.site-chrome-more-drawer__title');
    if (!el) return;
    var en = el.getAttribute('data-chrome-more-title-en') || 'More';
    if (!el.getAttribute('data-chrome-more-title-en')) el.setAttribute('data-chrome-more-title-en', en);
    var lang = getChromeLang();
    el.textContent = lang === 'ar' ? 'المزيد' : en;
  }

  var siteChromeMoreDrawerUiBound = false;

  function bindSiteChromeMoreDrawerUi() {
    if (siteChromeMoreDrawerUiBound) return;
    siteChromeMoreDrawerUiBound = true;
    document.addEventListener('click', function (e) {
      if (e.target.closest('.site-chrome-header__more-menu')) {
        e.preventDefault();
        var drawer = document.getElementById('siteChromeMoreDrawer');
        if (!drawer || drawer.hidden) openSiteChromeMoreDrawer();
        else closeSiteChromeMoreDrawer();
        return;
      }
      if (e.target.id === 'siteChromeMoreBackdrop' || e.target.closest('.site-chrome-more-drawer__close')) {
        closeSiteChromeMoreDrawer();
        return;
      }
      if (e.target.closest('.site-chrome-more-drawer__nav a[href]')) {
        closeSiteChromeMoreDrawer();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSiteChromeMoreDrawer();
    });
  }

  var NAV_LOADER_KEY = 'block_nav_loader_pending';
  var NAV_LOADER_TS_KEY = 'block_nav_loader_ts';
  var NAV_LOADER_MIN_MS = 2600;
  var navLoaderSafetyTimer = null;
  var navTrackedRequests = 0;
  var navLoaderWaitTimer = null;

  function normalizePathname(p) {
    var s = String(p || '');
    if (s.length > 1 && s.endsWith('/')) return s.slice(0, -1) || '/';
    return s || '/';
  }

  function ensureTicketLoader() {
    var existing = document.getElementById('blockTicketLoader');
    if (existing) {
      if (existing.querySelector('.block-ticket-loader__svg')) return;
      existing.remove();
    }
    var wrap = document.createElement('div');
    wrap.id = 'blockTicketLoader';
    wrap.className = 'block-ticket-loader';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="block-ticket-loader__backdrop" aria-hidden="true"></div>' +
      '<div class="block-ticket-loader__center">' +
      '<div class="block-ticket-loader__tilt">' +
      '<div class="block-ticket-loader__svg-host" role="status" aria-live="polite" aria-label="Loading">' +
      '<svg class="block-ticket-loader__svg" viewBox="0 0 240 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<defs>' +
      '<mask id="blockTicketLoaderMask"><rect width="240" height="128" fill="white"/>' +
      '<circle cx="24" cy="64" r="13" fill="black"/><circle cx="216" cy="64" r="13" fill="black"/></mask>' +
      '<linearGradient id="blockTicketBarShine" x1="0%" y1="0%" x2="100%" y2="0%">' +
      '<stop offset="0%" stop-color="#0066ff" stop-opacity="0.35"/><stop offset="45%" stop-color="#4d94ff" stop-opacity="1"/>' +
      '<stop offset="55%" stop-color="#4d94ff" stop-opacity="1"/><stop offset="100%" stop-color="#0066ff" stop-opacity="0.35"/></linearGradient>' +
      '</defs>' +
      '<g class="block-ticket-loader__svg-g">' +
      '<rect class="block-ticket-loader__shape" x="12" y="14" width="216" height="100" rx="12" ry="12" fill="#080c14" stroke="#0066ff" stroke-width="3" mask="url(#blockTicketLoaderMask)"/>' +
      '<line class="block-ticket-loader__vline" x1="149" y1="28" x2="149" y2="100" stroke="#0066ff" stroke-width="2" stroke-linecap="round"/>' +
      '<rect class="block-ticket-loader__bar" x="28" y="38" width="108" height="7" rx="2" fill="url(#blockTicketBarShine)"/>' +
      '<rect class="block-ticket-loader__bar block-ticket-loader__bar--2" x="28" y="54" width="122" height="7" rx="2" fill="#0066ff"/>' +
      '<rect class="block-ticket-loader__bar block-ticket-loader__bar--3" x="28" y="70" width="76" height="7" rx="2" fill="#0066ff"/>' +
      '</g></svg></div></div></div>';
    document.body.appendChild(wrap);
  }

  function updateTicketLoaderCopy() {
    var el = document.getElementById('blockTicketLoader');
    if (!el) return;
    var ar = document.documentElement.lang === 'ar' || document.body.classList.contains('rtl');
    var status = el.querySelector('.block-ticket-loader__svg-host[role="status"]');
    if (status) status.setAttribute('aria-label', ar ? 'جاري التحميل' : 'Loading');
  }

  function hideTicketLoader() {
    var el = document.getElementById('blockTicketLoader');
    if (el) {
      el.hidden = true;
      el.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('block-ticket-loader-open');
    if (navLoaderSafetyTimer) {
      clearTimeout(navLoaderSafetyTimer);
      navLoaderSafetyTimer = null;
    }
    if (navLoaderWaitTimer) {
      clearTimeout(navLoaderWaitTimer);
      navLoaderWaitTimer = null;
    }
  }

  function showTicketLoader() {
    ensureTicketLoader();
    updateTicketLoaderCopy();
    var el = document.getElementById('blockTicketLoader');
    if (!el) return;
    el.hidden = false;
    el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('block-ticket-loader-open');
    if (navLoaderSafetyTimer) clearTimeout(navLoaderSafetyTimer);
    navLoaderSafetyTimer = setTimeout(hideTicketLoader, 30000);
  }

  function canHideNavLoaderNow() {
    return document.readyState === 'complete' && navTrackedRequests <= 0;
  }

  function scheduleHideTicketLoaderAfterNav(startedAt) {
    var t0 = typeof startedAt === 'number' ? startedAt : Date.now();
    function finish() {
      var elapsed = Date.now() - t0;
      var wait = Math.max(0, NAV_LOADER_MIN_MS - elapsed);
      setTimeout(hideTicketLoader, wait);
    }
    function check() {
      if (canHideNavLoaderNow()) {
        finish();
        return;
      }
      navLoaderWaitTimer = setTimeout(check, 120);
    }
    check();
  }

  function beginNavLoaderFromClick() {
    try {
      sessionStorage.setItem(NAV_LOADER_KEY, '1');
      sessionStorage.setItem(NAV_LOADER_TS_KEY, String(Date.now()));
    } catch (e) {}
    showTicketLoader();
  }

  function resumeNavLoaderIfPending() {
    try {
      if (sessionStorage.getItem(NAV_LOADER_KEY) !== '1') return;
      var tsRaw = sessionStorage.getItem(NAV_LOADER_TS_KEY);
      var started = tsRaw ? parseInt(tsRaw, 10) : NaN;
      if (!started || isNaN(started)) started = Date.now();
      sessionStorage.removeItem(NAV_LOADER_KEY);
      sessionStorage.removeItem(NAV_LOADER_TS_KEY);
      showTicketLoader();
      scheduleHideTicketLoaderAfterNav(started);
    } catch (e) {
      try {
        sessionStorage.removeItem(NAV_LOADER_KEY);
        sessionStorage.removeItem(NAV_LOADER_TS_KEY);
      } catch (e2) {}
    }
  }

  function isTrackedNavAnchor(a) {
    if (!a) return false;
    if (a.closest('.site-chrome-nav--header')) return true;
    if (a.closest('.site-chrome-nav--footer')) return true;
    if (a.classList.contains('site-chrome-header__logo-wrap')) return true;
    if (a.closest('.home-drawer__nav')) return true;
    if (a.closest('#homeDrawer')) return true;
    if (a.closest('.site-chrome-more-drawer__nav')) return true;
    if (a.closest('.tk-main-nav')) return true;
    return false;
  }

  function bindNavLoaderClicks() {
    document.addEventListener(
      'click',
      function (e) {
        var a = e.target && e.target.closest && e.target.closest('a[href]');
        if (!a) return;
        if (e.defaultPrevented) return;
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (a.target === '_blank') return;
        if (a.hasAttribute('download')) return;
        var hrefAttr = a.getAttribute('href') || '';
        if (hrefAttr.startsWith('mailto:') || hrefAttr.startsWith('tel:') || hrefAttr.startsWith('javascript:')) return;
        if (!isTrackedNavAnchor(a)) return;
        var url;
        try {
          url = new URL(a.href, window.location.href);
        } catch (err) {
          return;
        }
        if (url.origin !== window.location.origin) return;
        var cur = normalizePathname(window.location.pathname) + window.location.search;
        var next = normalizePathname(url.pathname) + url.search;
        if (cur === next) return;
        beginNavLoaderFromClick();
      },
      true
    );
  }

  function bindHeaderScrollContrast() {
    var ticking = false;
    function apply() {
      ticking = false;
      var threshold = Math.max(140, Math.round(window.innerHeight * 0.18));
      var onLight = (window.scrollY || window.pageYOffset || 0) > threshold;
      document.body.classList.toggle('chrome-on-light', onLight);
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(apply);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    apply();
  }

  function patchRequestTracking() {
    if (window.__blockNavLoaderPatched) return;
    window.__blockNavLoaderPatched = true;

    if (typeof window.fetch === 'function') {
      var originalFetch = window.fetch.bind(window);
      var inflightGetApi = new Map();
      var cacheablePrefixes = ['/api/events', '/api/event-thumbs', '/api/booking-event/'];
      function shouldDedupeFetch(input, init) {
        var method = String((init && init.method) || 'GET').toUpperCase();
        if (method !== 'GET') return false;
        var reqUrl = '';
        try {
          if (typeof input === 'string') reqUrl = input;
          else if (input && typeof input.url === 'string') reqUrl = input.url;
          else return false;
          var u = new URL(reqUrl, window.location.href);
          if (u.origin !== window.location.origin) return false;
          return cacheablePrefixes.some(function (p) {
            return u.pathname.indexOf(p) === 0;
          });
        } catch (e) {
          return false;
        }
      }
      function dedupeKey(input) {
        try {
          if (typeof input === 'string') return new URL(input, window.location.href).toString();
          if (input && typeof input.url === 'string') return new URL(input.url, window.location.href).toString();
        } catch (e) {}
        return String(input || '');
      }
      window.fetch = function () {
        navTrackedRequests++;
        var args = arguments;
        var firstArg = args[0];
        var initArg = args[1] || null;
        if (shouldDedupeFetch(firstArg, initArg)) {
          var key = dedupeKey(firstArg);
          var pending = inflightGetApi.get(key);
          if (pending) {
            return pending.then(function (resp) {
              return resp.clone();
            }).finally(function () {
              navTrackedRequests = Math.max(0, navTrackedRequests - 1);
            });
          }
          var baseReq = originalFetch.apply(null, args);
          inflightGetApi.set(key, baseReq);
          return baseReq.then(function (resp) {
            return resp.clone();
          }).finally(function () {
            inflightGetApi.delete(key);
            navTrackedRequests = Math.max(0, navTrackedRequests - 1);
          });
        }
        return originalFetch.apply(null, args).finally(function () {
          navTrackedRequests = Math.max(0, navTrackedRequests - 1);
        });
      };
    }

    if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
      var origSend = window.XMLHttpRequest.prototype.send;
      window.XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        navTrackedRequests++;
        var done = false;
        function onDone() {
          if (done) return;
          done = true;
          navTrackedRequests = Math.max(0, navTrackedRequests - 1);
          xhr.removeEventListener('loadend', onDone);
          xhr.removeEventListener('error', onDone);
          xhr.removeEventListener('abort', onDone);
        }
        xhr.addEventListener('loadend', onDone);
        xhr.addEventListener('error', onDone);
        xhr.addEventListener('abort', onDone);
        return origSend.apply(this, arguments);
      };
    }
  }

  window.addEventListener('pageshow', function (ev) {
    if (ev.persisted) hideTicketLoader();
  });

  window.blockTicketLoader = {
    show: showTicketLoader,
    hide: hideTicketLoader,
    /** If a nav click set the loader timestamp, hide after min display time; otherwise hide now. */
    markContentReady: function () {
      try {
        var tsRaw = sessionStorage.getItem(NAV_LOADER_TS_KEY);
        if (tsRaw) {
          var started = parseInt(tsRaw, 10);
          if (!started || isNaN(started)) hideTicketLoader();
          else scheduleHideTicketLoaderAfterNav(started);
        } else {
          hideTicketLoader();
        }
      } catch (e) {
        hideTicketLoader();
      }
    },
  };

  document.addEventListener('DOMContentLoaded', function () {
    patchRequestTracking();
    resumeNavLoaderIfPending();
    splitHeaderDom();
    injectLanguageSwitcher();
    splitFooterDom();
    fetch('/api/site-config')
      .then(function (r) {
        return r.json();
      })
      .then(function (c) {
        injectNavFromConfig(c);
        setNavActive();
        setCopyrightFromConfig(c);
        fillHeaderSocialFromConfig(c);
        fillFooterSocialFromConfig(c);
        applyDataBlockSocial(c);
        applyChromeHeaderFooterI18n(getChromeLang());
      })
      .catch(function () {
        injectNavFromConfig({
          links: DEFAULT_CHROME_LINKS,
          headerLinks: DEFAULT_CHROME_LINKS,
          footerLinks: DEFAULT_CHROME_LINKS,
        });
        setNavActive();
        setCopyrightFromConfig({});
        var emptySocial = { socialLinks: [] };
        fillHeaderSocialFromConfig(emptySocial);
        fillFooterSocialFromConfig(emptySocial);
        applyDataBlockSocial(emptySocial);
        applyChromeHeaderFooterI18n(getChromeLang());
      });
    bindSessionChrome();
    bindNavLoaderClicks();
    bindHeaderScrollContrast();
  });
})();
