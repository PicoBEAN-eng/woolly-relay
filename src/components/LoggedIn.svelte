<script lang="ts">
	import { debounce, Notice, Platform } from "obsidian";
	import type Live from "../main";
	import WelcomeHeader from "./WelcomeHeader.svelte";
	import WelcomeFooter from "./WelcomeFooter.svelte";
	import AccountSettingItem from "./AccountSettingItem.svelte";
	import SettingItemHeading from "./SettingItemHeading.svelte";
	import Callout from "./Callout.svelte";
	import Announcement from "./Announcement.svelte";
	import type { LoginManager, Provider } from "src/LoginManager";
	import { derived, writable } from "svelte/store";
	import { onMount } from "svelte";
	import { slide } from "svelte/transition";
	import { quintOut } from "svelte/easing";
	import type {
		AuthProviderInfo,
		RecordAuthResponse,
		RecordModel,
	} from "pocketbase";
	import { customFetch } from "src/customFetch";
	import { curryLog } from "src/debug";
	import { FeatureFlagManager, flags } from "src/flagManager";

	export let plugin: Live;

	let errorLog = curryLog("LoggedIn.svelte", "error");

	let lm: LoginManager;
	let automaticFlow = writable<boolean>(!Platform.isIosApp);
	let pending = writable<boolean>(false);
	lm = plugin.loginManager;
	let timedOut = writable<boolean>(false);
	let success = writable<boolean>(false);
	let useCustomFetch = writable<boolean>(true);
	let selectedProvider = writable<string>("");
	let flagManager = FeatureFlagManager.getInstance();

	let providers: Record<string, Provider> = {};
	let hasProviderInfo = writable<boolean>(false);
	const loginSettings = lm.loginSettings;

	// Load cached providers from localStorage, keyed by auth URL
	let cachedProviders = writable<string[]>([]);
	let shouldAnimate = writable<boolean>(false);
	const PROVIDERS_CACHE_PREFIX = "pictureframes-relay-auth-providers-";

	function getCacheKey(): string {
		// Use the PocketBase URL as the cache key
		const pbUrl = lm.pb?.baseUrl || "default";
		return `${PROVIDERS_CACHE_PREFIX}${pbUrl}`;
	}

	function getDefaultProviders(): string[] {
		const defaults = ["github", "google", "microsoft"];

		if ($flagManager.getFlag("enableDiscordLogin")) {
			defaults.push("discord");
		}
		// OIDC is intentionally excluded from defaults

		return defaults;
	}

	function loadCachedProviders(): string[] {
		try {
			const cacheKey = getCacheKey();
			const cached = localStorage.getItem(cacheKey);
			if (cached) {
				return JSON.parse(cached);
			}
		} catch (e) {
			errorLog("Failed to load cached providers:", e);
		}
		// Return default providers if no cache exists
		return getDefaultProviders();
	}

	function saveCachedProviders(providerList: string[]) {
		try {
			const cacheKey = getCacheKey();
			localStorage.setItem(cacheKey, JSON.stringify(providerList));
		} catch (e) {
			errorLog("Failed to save cached providers:", e);
		}
	}

	const enabledProviders = derived([selectedProvider, flagManager], () => {
		const availableProviders = ["github", "google", "microsoft", "oidc"];

		if ($flagManager.getFlag("enableDiscordLogin")) {
			availableProviders.push("discord");
		}

		return availableProviders;
	});

	const visibleProviders = derived(
		[
			selectedProvider,
			lm.loginSettings,
			flagManager,
			hasProviderInfo,
			cachedProviders,
		],
		() => {
			// First check the loginSettings store
			if ($loginSettings && $loginSettings.provider)
				return [$loginSettings.provider];

			// Fall back to selectedProvider for compatibility
			if ($selectedProvider !== "") return [$selectedProvider];

			// If we have provider info from the API, only show those that are available
			if ($hasProviderInfo && Object.keys(providers).length > 0) {
				// Filter to only show providers that were returned from the API
				const availableFromApi = Object.keys(providers);
				const visible = [];

				// Check each provider in preferred order
				if (availableFromApi.includes("google")) {
					visible.push("google");
				}
				if (availableFromApi.includes("microsoft")) {
					visible.push("microsoft");
				}
				if (
					availableFromApi.includes("discord") &&
					$flagManager.getFlag("enableDiscordLogin")
				) {
					visible.push("discord");
				}
				if (availableFromApi.includes("github")) {
					visible.push("github");
				}

				// Include any OIDC providers (oidc, oidc2, oidc-custom, etc.)
				availableFromApi.forEach((provider) => {
					if (provider.startsWith("oidc")) {
						visible.push(provider);
					}
				});

				// Check if the list has changed from what we expected (cached or defaults)
				const hasChanged =
					JSON.stringify(visible.sort()) !==
					JSON.stringify($cachedProviders.sort());
				shouldAnimate.set(hasChanged);

				// Save to cache for next time
				saveCachedProviders(visible);

				return visible;
			}

			// If we have cached providers and no API info yet, use the cache
			if ($cachedProviders.length > 0 && !$hasProviderInfo) {
				return $cachedProviders;
			}

			// Default behavior if no provider info yet or request failed
			const visible = ["github", "google", "microsoft"];

			if ($flagManager.getFlag("enableDiscordLogin")) {
				visible.push("discord");
			}

			return visible;
		},
	);

	function clearPreferredProvider() {
		lm.clearPreferredProvider();
		selectedProvider.set("");
		initiate();
	}

	const configuredProviders = derived(
		[selectedProvider, plugin.loginSettings, flagManager, hasProviderInfo],
		() => {
			if ($selectedProvider) return [$selectedProvider];
			return Object.keys(providers);
		},
	);

	const providerDisplayNames = derived([hasProviderInfo], () => {
		const names: Record<string, string> = {};
		for (const providerName of Object.keys(providers)) {
			const provider = providers[providerName];

			if (provider?.info?.displayName) {
				names[providerName] = provider.info.displayName;
			} else {
				names[providerName] = capitalize(providerName);
			}
		}
		return names;
	});

	let authWithCode: (code: string) => Promise<RecordAuthResponse<RecordModel>>;
	let error = writable<string>("");

	async function logout() {
		plugin.loginManager.logout();
		success.set(false);
		pending.set(false);
		selectedProvider.set("");
		timedOut.set(false);
	}

	async function login(providerName: string) {
		try {
			selectedProvider.set(providerName);
			const loginSuccess = await plugin.loginManager.login(providerName);
			if (loginSuccess) {
				success.set(true);
			}
		} catch (e) {
			automaticFlow.set(false);
			success.set(false);
			const provider = providers[providerName];
			if (provider) {
				window.open(provider.fullAuthUrl, "_blank");
				poll(providerName);
			}
		}
	}

	const anyPb = writable<any>(plugin.loginManager.pb as any);

	function refresh() {
		anyPb.set(plugin.loginManager.pb as any);
	}

	function initiate() {
		try {
			const whichFetch = $useCustomFetch ? customFetch : fetch;
			lm.initiateManualOAuth2CodeFlow(whichFetch, $enabledProviders)
				.then((providers_) => {
					providers = providers_;
					hasProviderInfo.set(true);
					// Update webview intercepts with the loaded provider info
					lm.updateWebviewIntercepts(providers_);
				})
				.catch((e) => {
					let message = e.message;
					message = message;
					error.set(message);
					success.set(false);
					selectedProvider.set("");
					throw e;
				});
		} catch (e: any) {
			error.set(e.message);
		}
	}

	onMount(() => {
		success.set(false);
		// Load cached providers on mount
		const cached = loadCachedProviders();
		cachedProviders.set(cached);
		initiate();
	});

	async function poll(providerName: string) {
		const provider = providers[providerName];
		if (!provider) {
			return;
		}
		selectedProvider.set(providerName);
		return await plugin.loginManager
			.poll(provider)
			.then((authRecord) => {
				success.set(true);
				pending.set(false);
				error.set("");
			})
			.catch((e) => {
				timedOut.set(true);
				pending.set(false);
				success.set(false);
				error.set(e.message);
			});
	}

	function selectText(event: Event) {
		const inputEl = event.target as HTMLInputElement;
		inputEl.focus();
		inputEl.select();
		navigator.clipboard
			.writeText(inputEl.value)
			.then(() => new Notice("Invite link copied"))
			.catch((err) => {});
		poll($selectedProvider);
	}

	function capitalize(s: string): string {
		if (!s) return "";
		if (s == "oidc") return "OIDC";
		if (s == "github") return "GitHub";
		return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
	}
</script>

{#if $lm.hasUser && $lm.user}
	<SettingItemHeading name="Pictureframes Relay"></SettingItemHeading>
	<SettingItemHeading name="Account"></SettingItemHeading>
	<AccountSettingItem user={$lm.user}>
		<button
			on:click={debounce(() => {
				logout();
			})}>Logout</button
		>
	</AccountSettingItem>
	<slot></slot>
{:else}
	{#if Platform.isMobile}
		<Announcement {plugin} />
	{/if}
	<div class="welcome">
		<WelcomeHeader />
		{#if $automaticFlow}
			<div class="login-buttons">
				<!-- One-click sign in: Google is the only provider on this deployment. -->
				<button
					class="google-sign-in-button"
					disabled={$pending || !$configuredProviders.contains("google")}
					on:click={debounce(async () => {
						pending.set(true);
						await login("google");
					})}>Sign in with Google</button
				>
			</div>
		{:else}
			<div class="login-buttons">
				{#if providers["google"]}
					<a href={providers["google"].fullAuthUrl} target="_blank">
						<button
							class="google-sign-in-button"
							disabled={$pending}
							on:click={() => {
								pending.set(true);
								poll("google");
							}}>Sign in with Google</button
						>
					</a>
				{:else}
					<button class="google-sign-in-button" disabled={true}
						>Sign in with Google</button
					>
				{/if}
			</div>
		{/if}
		{#if $error}
			<p>
				{$error}.<br />
				{#if $timedOut && $selectedProvider}
					Already logged in? <button
						class="link link-button"
						on:click={debounce(() => {
							poll($selectedProvider);
						})}>(click here)</button
					>
				{/if}
			</p>
			<p class="not-working">
				Not working?
				<button
					class="link link-button"
					on:click={() => {
						pending.set(false);
						automaticFlow.set(false);
						error.set("");
						selectedProvider.set("");
						hasProviderInfo.set(false);
						initiate();
					}}>(try again)</button
				>
			</p>
		{:else if $pending}
			<div>
				<p class="continue">Continue in your browser...</p>
				<p class="not-working">
					Not working?
					<button
						class="link link-button"
						on:click={() => {
							pending.set(false);
							automaticFlow.set(false);
							error.set("");
							selectedProvider.set("");
						}}>(try again)</button
					>
				</p>
			</div>
		{/if}
	</div>
	<WelcomeFooter />
{/if}

<style>
	.continue {
		font-weight: 600;
		font-size: larger;
		margin-top: 0;
		margin-bottom: 0px;
	}
	.link {
		color: var(--text-muted);
	}

	.link:hover {
		color: var(--text-normal);
	}

	.not-working {
		margin-top: 0px;
		margin-bottom: 0px;
		color: var(--text-faint);
		font-size: 0.75em;
	}

	.link-button {
		box-shadow: none;
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		text-decoration: underline;
	}

	button.link-button:hover {
		box-shadow: none;
		color: var(--text-normal);
	}

	button.link.link-button {
		height: auto;
		padding: 0;
	}

	.welcome {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 10vh 2rem 1rem 2rem;
		max-width: 640px;
		margin: 0 auto;
		gap: 2rem;
	}

	.google-sign-in-button {
		width: 100%;
		height: unset;
		padding: 12px 16px 12px 42px !important;
		border: none;
		border-radius: 3px;
		box-shadow:
			0 -1px 0 rgba(0, 0, 0, 0.04),
			0 1px 1px rgba(0, 0, 0, 0.25);
		color: var(--text-color);
		font-size: 14px;
		font-weight: 500;
		font-family:
			-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu,
			Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
		background-image: url(data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTgiIGhlaWdodD0iMTgiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGcgZmlsbD0ibm9uZSIgZmlsbC1ydWxlPSJldmVub2RkIj48cGF0aCBkPSJNMTcuNiA5LjJsLS4xLTEuOEg5djMuNGg0LjhDMTMuNiAxMiAxMyAxMyAxMiAxMy42djIuMmgzYTguOCA4LjggMCAwIDAgMi42LTYuNnoiIGZpbGw9IiM0Mjg1RjQiIGZpbGwtcnVsZT0ibm9uemVybyIvPjxwYXRoIGQ9Ik05IDE4YzIuNCAwIDQuNS0uOCA2LTIuMmwtMy0yLjJhNS40IDUuNCAwIDAgMS04LTIuOUgxVjEzYTkgOSAwIDAgMCA4IDV6IiBmaWxsPSIjMzRBODUzIiBmaWxsLXJ1bGU9Im5vbnplcm8iLz48cGF0aCBkPSJNNCAxMC43YTUuNCA1LjQgMCAwIDEgMC0zLjRWNUgxYTkgOSAwIDAgMCAwIDhsMy0yLjN6IiBmaWxsPSIjRkJCQzA1IiBmaWxsLXJ1bGU9Im5vbnplcm8iLz48cGF0aCBkPSJNOSAzLjZjMS4zIDAgMi41LjQgMy40IDEuM0wxNSAyLjNBOSA5IDAgMCAwIDEgNWwzIDIuNGE1LjQgNS40IDAgMCAxIDUtMy43eiIgZmlsbD0iI0VBNDMzNSIgZmlsbC1ydWxlPSJub256ZXJvIi8+PHBhdGggZD0iTTAgMGgxOHYxOEgweiIvPjwvZz48L3N2Zz4=);
		background-color: var(--background-secondary);
		background-repeat: no-repeat;
		background-position: 12px 11px;
	}

	.google-sign-in-button:hover {
		box-shadow:
			0 -1px 0 rgba(0, 0, 0, 0.04),
			0 2px 4px rgba(0, 0, 0, 0.25);
	}

	.google-sign-in-button:disabled {
		cursor: unset;
		filter: grayscale(100%);
		box-shadow:
			0 -1px 0 rgba(0, 0, 0, 0.04),
			0 1px 1px rgba(0, 0, 0, 0.25);
	}

	.login-buttons {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		padding: 1rem;
		background: var(--background-modifier-border-hover);
		border-radius: 0.5rem;
	}

</style>
