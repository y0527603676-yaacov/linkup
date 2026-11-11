<?php
/* ISOLATED TEST STORE ONLY: no mail server here – e-mails are dropped. */
add_filter('pre_wp_mail', '__return_true');
