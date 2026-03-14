<!doctype html>
<html <?php language_attributes(); ?>>
  <head>
    <meta charset="<?php bloginfo('charset'); ?>" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <?php wp_head(); ?>
  </head>
  <body <?php body_class(); ?>>
    <?php wp_body_open(); ?>

    <div class="top-note">For research and educational use. Not intended for diagnostic use.</div>

    <header class="site-header">
      <div class="container nav-wrap">
        <a class="brand" href="<?php echo esc_url(home_url('/')); ?>">
          <span class="brand-mark">KB</span>
          <span class="brand-text">
            <span class="brand-name">KreatBio</span>
            <span class="brand-sub">Biotech Tools for Research and Learning</span>
          </span>
        </a>

        <button class="menu-toggle" data-menu-toggle aria-expanded="false" aria-label="Toggle menu">Menu</button>

        <nav class="nav-menu" data-menu>
          <a class="nav-link <?php echo kreatbio_authority_is_active_slug('home') ? 'active' : ''; ?>" href="<?php echo esc_url(kreatbio_authority_page_url('home')); ?>">Home</a>
          <a class="nav-link <?php echo kreatbio_authority_is_active_slug('products') ? 'active' : ''; ?>" href="<?php echo esc_url(kreatbio_authority_page_url('products')); ?>">Products</a>
          <a class="nav-link <?php echo kreatbio_authority_is_active_slug('resources') ? 'active' : ''; ?>" href="<?php echo esc_url(kreatbio_authority_page_url('resources')); ?>">Resources</a>
          <a class="nav-link <?php echo kreatbio_authority_is_active_slug('about') ? 'active' : ''; ?>" href="<?php echo esc_url(kreatbio_authority_page_url('about')); ?>">About</a>
          <a class="nav-link <?php echo kreatbio_authority_is_active_slug('contact') ? 'active' : ''; ?>" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Contact</a>
          <a class="btn btn-primary nav-cta" href="<?php echo esc_url(kreatbio_authority_page_url('contact')); ?>">Request a Quote</a>
        </nav>
      </div>
    </header>