<?php
/**
 * REST safety net for global class saves.
 *
 * @package ElementorClassLock
 */

namespace ElementorClassLock;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Blocks unauthenticated-looking PUT requests to global-classes without the unlock nonce header.
 */
final class Class_Save_Guard {

	private static ?self $instance = null;

	public const NONCE_ACTION = 'ecl_global_classes';

	public const HEADER = 'X-ECL-Unlock-Token';

	public static function instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public function register(): void {
		add_filter( 'rest_pre_dispatch', [ $this, 'maybe_block_global_classes_put' ], 5, 3 );
		add_action( 'elementor/global_classes/update', [ $this, 'log_global_classes_update' ], 10, 3 );
	}

	/**
	 * @param mixed           $result  Prior result.
	 * @param \WP_REST_Server $server  REST server.
	 * @param \WP_REST_Request $request Current request.
	 * @return mixed|\WP_Error
	 */
	public function maybe_block_global_classes_put( $result, $server, $request ) {
		if ( $result instanceof \WP_Error ) {
			return $result;
		}
		if ( ! $request instanceof \WP_REST_Request ) {
			return $result;
		}
		if ( strtoupper( $request->get_method() ) !== 'PUT' ) {
			return $result;
		}
		$route = $request->get_route();
		if ( '/elementor/v1/global-classes' !== $route ) {
			return $result;
		}
		$token = $request->get_header( self::HEADER );
		if ( ! $token || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $token ) ), self::NONCE_ACTION ) ) {
			Logger::log(
				'Blocked global-classes PUT (missing or invalid unlock token).',
				[
					'user_id' => get_current_user_id(),
				]
			);
			return new \WP_Error(
				'ecl_global_classes_forbidden',
				__( 'Global class update was blocked because the editor unlock token was missing or invalid.', 'elementor-class-lock' ),
				[ 'status' => 403 ]
			);
		}
		return $result;
	}

	/**
	 * @param string $context Context (e.g. preview / frontend).
	 * @param mixed  $new     New value.
	 * @param mixed  $old     Previous value.
	 */
	public function log_global_classes_update( string $context, $_new_value, $_old_value ): void {
		Logger::log(
			'Global classes updated.',
			[
				'context' => $context,
			]
		);
	}
}
