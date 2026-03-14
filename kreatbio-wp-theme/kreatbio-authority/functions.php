<?php
if (!defined('ABSPATH')) {
    exit;
}

function kreatbio_authority_setup() {
    add_theme_support('title-tag');
    add_theme_support('post-thumbnails');
}
add_action('after_setup_theme', 'kreatbio_authority_setup');

function kreatbio_authority_assets() {
    wp_enqueue_style(
        'kreatbio-authority-fonts',
        'https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=Source+Sans+3:wght@400;500;600;700&display=swap',
        array(),
        null
    );

    wp_enqueue_style(
        'kreatbio-authority-site',
        get_template_directory_uri() . '/assets/site.css',
        array('kreatbio-authority-fonts'),
        '1.0.0'
    );

    wp_enqueue_script(
        'kreatbio-authority-site',
        get_template_directory_uri() . '/assets/site.js',
        array(),
        '1.0.0',
        true
    );
}
add_action('wp_enqueue_scripts', 'kreatbio_authority_assets');

function kreatbio_authority_page_url($slug) {
    $page = get_page_by_path($slug);
    if ($page instanceof WP_Post) {
        return get_permalink($page->ID);
    }

    if ($slug === 'home') {
        return home_url('/');
    }

    return home_url('/' . trim($slug, '/') . '/');
}

function kreatbio_authority_is_active_slug($slug) {
    if ($slug === 'home' && is_front_page()) {
        return true;
    }

    if (is_page()) {
        $post = get_post();
        if ($post instanceof WP_Post && $post->post_name === $slug) {
            return true;
        }
    }

    return false;
}

function kreatbio_authority_seed_pages() {
    $pages = array(
        'home' => array(
            'title' => 'Home',
            'template' => 'templates/home.php',
            'menu_order' => 1,
        ),
        'products' => array(
            'title' => 'Products',
            'template' => 'templates/products.php',
            'menu_order' => 2,
        ),
        'kreatpure-dna-kit' => array(
            'title' => 'KreatPure DNA Kit',
            'template' => 'templates/kreatpure-dna-kit.php',
            'menu_order' => 3,
        ),
        'kodageno-learning-platform' => array(
            'title' => 'KodaGeno Learning Platform',
            'template' => 'templates/kodageno-learning-platform.php',
            'menu_order' => 4,
        ),
        'resources' => array(
            'title' => 'Resources',
            'template' => 'templates/resources.php',
            'menu_order' => 5,
        ),
        'about' => array(
            'title' => 'About',
            'template' => 'templates/about.php',
            'menu_order' => 6,
        ),
        'contact' => array(
            'title' => 'Contact',
            'template' => 'templates/contact.php',
            'menu_order' => 7,
        ),
    );

    $ids = array();

    foreach ($pages as $slug => $config) {
        $existing = get_page_by_path($slug);

        if ($existing instanceof WP_Post) {
            $page_id = $existing->ID;
            wp_update_post(
                array(
                    'ID' => $page_id,
                    'post_title' => $config['title'],
                    'menu_order' => $config['menu_order'],
                )
            );
        } else {
            $page_id = wp_insert_post(
                array(
                    'post_type' => 'page',
                    'post_status' => 'publish',
                    'post_title' => $config['title'],
                    'post_name' => $slug,
                    'post_content' => '',
                    'menu_order' => $config['menu_order'],
                )
            );
        }

        if (!is_wp_error($page_id) && $page_id) {
            update_post_meta($page_id, '_wp_page_template', $config['template']);
            $ids[$slug] = (int) $page_id;
        }
    }

    if (!empty($ids['home'])) {
        update_option('show_on_front', 'page');
        update_option('page_on_front', $ids['home']);
    }

    flush_rewrite_rules();
}
add_action('after_switch_theme', 'kreatbio_authority_seed_pages');