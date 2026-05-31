import { useEffect, useState } from 'react'
import { Alert, Avatar, Button, Card, Chip, ComboBox, Description, Fieldset, Input, InputGroup, Label, ListBox, Separator, TextField, Typography } from '@heroui/react'
import { useRef, type ReactNode } from 'react'
import { Check, CheckCircle, Copy, Eye, EyeOff, FolderOpen, ImageIcon, Key, Plug, RefreshCw, RotateCcw, Search, ShieldCheck, X, Zap } from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import type { AccountProfile } from '../../../types/account'
import { dialog } from '../../../services/ipc'
import * as configService from '../../../services/config'
import { useSettingsStore } from '../settingsStore'

interface DatabaseTabProps {
  showMessage: (text: string, success: boolean) => void
}

type SecretFieldId = 'decryptKey' | 'imageXorKey' | 'imageAesKey'

interface PathFieldOptions {
  label: ReactNode
  helperText: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  onBrowse?: () => void
  onReset?: () => void
  browseLabel?: string
  resetLabel?: string
}

interface SecretFieldOptions {
  id: SecretFieldId
  label: ReactNode
  helperText: string
  placeholder: string
  value: string
  onChange: (value: string) => void
}

function DatabaseTab({ showMessage }: DatabaseTabProps) {
  const { setDbConnected, setLoading, setMyWxid: setCurrentWxid, userInfo } = useAppStore()
  const isMac = window.navigator.platform.toLowerCase().includes('mac')
  const decryptKey = useSettingsStore(s => s.config.decryptKey)
  const dbPath = useSettingsStore(s => s.config.dbPath)
  const wxid = useSettingsStore(s => s.config.wxid)
  const cachePath = useSettingsStore(s => s.config.cachePath)
  const imageXorKey = useSettingsStore(s => s.config.imageXorKey)
  const imageAesKey = useSettingsStore(s => s.config.imageAesKey)
  const hasUnsavedChanges = useSettingsStore(s => s.hasUnsavedChanges)
  const setField = useSettingsStore(s => s.setField)
  const setDecryptKey = (value: string) => setField('decryptKey', value)
  const setDbPath = (value: string) => setField('dbPath', value)
  const setWxid = (value: string) => setField('wxid', value)
  const setCachePath = (value: string) => setField('cachePath', value)
  const setImageXorKey = (value: string) => setField('imageXorKey', value)
  const setImageAesKey = (value: string) => setField('imageAesKey', value)
  const setEditingAccountId = (value: string) => setField('editingAccountId', value)

  const [accountsList, setAccountsList] = useState<AccountProfile[]>([])
  const [activeAccountId, setActiveAccountId] = useState('')
  const [wxidOptions, setWxidOptions] = useState<string[]>([])
  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [isAccountVerified, setIsAccountVerified] = useState(false)
  const [isVerifyingAccount, setIsVerifyingAccount] = useState(false)
  const [isLoading, setIsLoadingState] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isGettingKey, setIsGettingKey] = useState(false)
  const [keyStatus, setKeyStatus] = useState('')
  const [visibleSecrets, setVisibleSecrets] = useState<Record<SecretFieldId, boolean>>({
    decryptKey: false,
    imageXorKey: false,
    imageAesKey: false
  })
  const [copiedSecret, setCopiedSecret] = useState<SecretFieldId | null>(null)
  const copyTimerRef = useRef<number | null>(null)

  useEffect(() => {
    refreshAccountsState()
  }, [])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  const getAccountDisplayName = (account?: AccountProfile | null) => {
    if (!account) return '未命名账号'

    const activeNickname = account.id === activeAccountId ? userInfo?.nickName?.trim() : ''
    if (activeNickname) return activeNickname

    const savedName = account.displayName?.trim()
    if (savedName && savedName !== '未命名账号') return savedName

    return account.wxid?.trim() || '未命名账号'
  }

  const applyAccountToForm = (account: AccountProfile | null) => {
    setEditingAccountId(account?.id || '')
    setDecryptKey(account?.decryptKey || '')
    setDbPath(account?.dbPath || '')
    setWxid(account?.wxid || '')
    setCachePath(account?.cachePath || '')
    setImageXorKey(account?.imageXorKey || '')
    setImageAesKey(account?.imageAesKey || '')
    setIsAccountVerified(Boolean(account?.decryptKey && account?.dbPath && account?.wxid))
  }

  const refreshAccountsState = async (preferredEditingId?: string) => {
    const [accounts, activeAccount] = await Promise.all([
      configService.listAccounts(),
      configService.getActiveAccount()
    ])
    setAccountsList(accounts)
    setActiveAccountId(activeAccount?.id || '')

    const editingId = preferredEditingId || activeAccount?.id || accounts[0]?.id || ''
    const editingAccount = accounts.find(item => item.id === editingId) || activeAccount || accounts[0] || null
    applyAccountToForm(editingAccount)
    return { accounts, activeAccount, editingAccount }
  }

  const handleGetKey = async () => {
    if (isGettingKey) return
    setIsGettingKey(true)
    setKeyStatus(isMac ? '正在准备 macOS helper...' : '正在检查微信进程...')

    try {
      if (isMac) {
        const removeListener = window.electronAPI.wxKey.onStatus(({ status }) => {
          setKeyStatus(status)
        })

        const result = await window.electronAPI.wxKey.startGetKey(undefined, dbPath || undefined)
        removeListener()

        if (result.success && result.key) {
          setDecryptKey(result.key)

          if (dbPath) {
            const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, result.key)
            if (resolved.success && resolved.wxid) {
              setWxid(resolved.wxid)
              setIsAccountVerified(true)
              showMessage(`密钥获取成功！已验证账号: ${resolved.wxid}`, true)
              setKeyStatus('')
              return
            }
          }

          if (result.validatedWxid) {
            setWxid(result.validatedWxid)
            setIsAccountVerified(true)
            showMessage(`密钥获取成功！已验证账号: ${result.validatedWxid}`, true)
            setKeyStatus('')
            return
          }

          setKeyStatus('正在检测当前登录账号...')

          let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
          }

          if (accountInfo) {
            setWxid(accountInfo.wxid)
            setIsAccountVerified(false)
            showMessage(`密钥获取成功！已识别候选账号: ${accountInfo.wxid}，请继续验证目录。`, true)
          } else {
            const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
            setWxidOptions(wxids)
            setIsAccountVerified(false)

            if (wxids.length === 1) {
              setWxid(wxids[0])
              showMessage('密钥获取成功，已识别到 1 个候选账号目录，请继续验证。', true)
            } else if (wxids.length > 1) {
              showMessage(`密钥获取成功，识别到 ${wxids.length} 个候选账号目录，请选择后验证。`, true)
            } else {
              showMessage('密钥获取成功，请手动填写或扫描账号目录后继续验证。', true)
            }
          }

          setKeyStatus('')
        } else {
          showMessage(result.error || '获取密钥失败', false)
          setKeyStatus('')
        }

        return
      }

      const isRunning = await window.electronAPI.wxKey.isWeChatRunning()
      if (isRunning) {
        const shouldKill = window.confirm('检测到微信正在运行，需要重启微信才能获取密钥。\n是否关闭当前微信？')
        if (!shouldKill) {
          setKeyStatus('已取消')
          setIsGettingKey(false)
          return
        }
        setKeyStatus('正在关闭微信...')
        await window.electronAPI.wxKey.killWeChat()
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      setKeyStatus('正在启动微信...')
      const launched = await window.electronAPI.wxKey.launchWeChat()
      if (!launched) {
        showMessage('微信启动失败，请检查安装路径', false)
        setKeyStatus('')
        setIsGettingKey(false)
        return
      }

      setKeyStatus('等待微信窗口加载...')
      const windowReady = await window.electronAPI.wxKey.waitForWindow(15)
      if (!windowReady) {
        showMessage('等待微信窗口超时', false)
        setKeyStatus('')
        setIsGettingKey(false)
        return
      }

      const removeListener = window.electronAPI.wxKey.onStatus(({ status }) => {
        setKeyStatus(status)
      })

      setKeyStatus('Hook 已安装，请登录微信...')
      const result = await window.electronAPI.wxKey.startGetKey(undefined, dbPath || undefined)
      removeListener()

      if (result.success && result.key) {
        setDecryptKey(result.key)

        // 自动检测当前登录的微信账号
        setKeyStatus('正在检测当前登录账号...')

        // 先尝试较短的时间范围（刚登录的情况）
        let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10) // 10分钟

        // 如果没找到，尝试更长的时间范围
        if (!accountInfo) {
          accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60) // 1小时
        }

        if (accountInfo) {
          setWxid(accountInfo.wxid)
          showMessage(`密钥获取成功！已自动绑定账号: ${accountInfo.wxid}`, true)
        } else {
          showMessage('密钥获取成功，已自动保存！（未能自动检测账号，请手动输入 wxid）', true)
        }
        setKeyStatus('')
      } else {
        showMessage(result.error || '获取密钥失败', false)
        setKeyStatus('')
      }
    } catch (e) {
      showMessage(`获取密钥失败: ${e}`, false)
      setKeyStatus('')
    } finally {
      setIsGettingKey(false)
    }
  }

  const handleCancelGetKey = async () => {
    await window.electronAPI.wxKey.cancel()
    setIsGettingKey(false)
    setKeyStatus('')
  }

  const handleOpenWelcomeWindow = async () => {
    try {
      await window.electronAPI.window.openWelcomeWindow('add-account')
    } catch (e) {
      showMessage('打开引导窗口失败', false)
    }
  }

  const handleSwitchAccountAndReconnect = async (account: AccountProfile) => {
    if (account.id === activeAccountId) {
      showMessage('当前没有待切换账号', false)
      return
    }

    if (hasUnsavedChanges) {
      showMessage('请先保存当前账号表单，再执行切换', false)
      return
    }

    const target = account
    if (!target.dbPath || !target.decryptKey || !target.wxid) {
      showMessage('待切换账号配置不完整，请先保存并补全账号信息', false)
      return
    }

    setIsLoadingState(true)
    setLoading(true, '正在切换账号...')
    try {
      const switched = await configService.setActiveAccount(target.id)
      if (!switched) {
        throw new Error('切换账号失败')
      }

      const result = await window.electronAPI.wcdb.testConnection(target.dbPath, target.decryptKey, target.wxid)
      if (!result.success) {
        throw new Error(result.error || '账号重连失败')
      }

      await window.electronAPI.chat.close()
      await window.electronAPI.chat.refreshCache()
      await window.electronAPI.chat.connect()
      setDbConnected(true, target.dbPath)
      setCurrentWxid(target.wxid)
      await refreshAccountsState(target.id)
      showMessage(`已切换到账号：${getAccountDisplayName(target)}`, true)
    } catch (e) {
      showMessage(`切换账号失败: ${e}`, false)
    } finally {
      setIsLoadingState(false)
      setLoading(false)
    }
  }

  const handleSelectDbPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择微信数据库根目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        setWxid('')
        setWxidOptions([])
        setIsAccountVerified(false)
        showMessage('已选择数据库目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择缓存目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        showMessage('已选择缓存目录', true)
      }
    } catch (e) {
      showMessage('选择缓存目录失败', false)
    }
  }

  // 扫描 wxid
  const handleScanWxid = async () => {
    if (!dbPath) {
      showMessage('请先配置数据库路径', false)
      return
    }
    if (isScanningWxid) return

    setIsScanningWxid(true)
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setIsAccountVerified(false)
      if (wxids.length === 0) {
        showMessage('未检测到账号目录（需包含 db_storage 文件夹）', false)
        setWxidOptions([])
      } else if (wxids.length === 1) {
        // 只有一个账号，直接设置
        setWxid(wxids[0])
        showMessage(`已检测到候选账号目录：${wxids[0]}（待验证）`, true)
        setWxidOptions([])
      } else {
        let selectedWxid = ''

        if (decryptKey.length === 64) {
          const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, decryptKey)
          if (resolved.success && resolved.wxid && wxids.includes(resolved.wxid)) {
            selectedWxid = resolved.wxid
            setWxid(selectedWxid)
          }
        }

        if (!selectedWxid) {
          let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
          }

          if (accountInfo && wxids.includes(accountInfo.wxid)) {
            selectedWxid = accountInfo.wxid
            setWxid(selectedWxid)
          }
        }

        setWxidOptions(wxids)
        showMessage(
          selectedWxid
            ? `检测到 ${wxids.length} 个候选账号目录，已按最新活动优先选择：${selectedWxid}`
            : `检测到 ${wxids.length} 个候选账号目录，请选择后验证`,
          true
        )
      }
    } catch (e) {
      showMessage(`扫描失败: ${e}`, false)
    } finally {
      setIsScanningWxid(false)
    }
  }

  // 选择 wxid
  const handleSelectWxid = async (selectedWxid: string) => {
    setWxid(selectedWxid)
    setIsAccountVerified(false)
    showMessage(`已选择候选账号目录：${selectedWxid}（待验证）`, true)
  }

  const handleVerifyAccountDirectory = async () => {
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey || decryptKey.length !== 64) { showMessage('请先配置64位解密密钥', false); return }
    if (!wxid) { showMessage('请先选择账号目录', false); return }

    setIsVerifyingAccount(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (result.success) {
        setIsAccountVerified(true)
        showMessage(`账号目录验证成功：${wxid}`, true)
      } else {
        setIsAccountVerified(false)
        showMessage(result.error || '账号目录验证失败，请更换目录重试', false)
      }
    } catch (e) {
      setIsAccountVerified(false)
      showMessage(`账号目录验证失败: ${e}`, false)
    } finally {
      setIsVerifyingAccount(false)
    }
  }

  const handleTestConnection = async () => {
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey) { showMessage('请先输入解密密钥', false); return }
    if (decryptKey.length !== 64) { showMessage('密钥长度必须为64个字符', false); return }
    if (!wxid) { showMessage('请先选择账号目录', false); return }
    if (!isAccountVerified) { showMessage('请先验证账号目录', false); return }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (result.success) {
        showMessage('连接测试成功！数据库可正常访问', true)
      } else {
        showMessage(result.error || '连接测试失败', false)
      }
    } catch (e) {
      showMessage(`连接测试失败: ${e}`, false)
    } finally {
      setIsTesting(false)
    }
  }

  const toggleSecretVisibility = (id: SecretFieldId) => {
    setVisibleSecrets(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const handleCopySecret = async (id: SecretFieldId, value: string) => {
    if (!value) return

    try {
      await navigator.clipboard.writeText(value)
      setCopiedSecret(id)

      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current)
      }

      copyTimerRef.current = window.setTimeout(() => {
        setCopiedSecret(null)
        copyTimerRef.current = null
      }, 1400)
    } catch (error) {
      setCopiedSecret(null)
      console.error('复制密钥失败:', error)
    }
  }

  const renderStatus = (message: string) => {
    if (!message) return null

    return (
      <Alert status="accent">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>{message}</Alert.Title>
        </Alert.Content>
      </Alert>
    )
  }

  const renderPathField = ({
    label,
    helperText,
    placeholder,
    value,
    onChange,
    onBrowse,
    onReset,
    browseLabel = '浏览选择',
    resetLabel = '恢复默认'
  }: PathFieldOptions) => (
    <TextField fullWidth value={value} onChange={onChange}>
      <Label>{label}</Label>
      <InputGroup fullWidth variant="secondary">
        <InputGroup.Input placeholder={placeholder} />
        {(onBrowse || onReset) && (
          <InputGroup.Suffix className="pr-0">
            {onBrowse && (
              <Button type="button" variant="ghost" size="sm" isIconOnly onPress={onBrowse} aria-label={browseLabel}>
                <FolderOpen size={16} />
              </Button>
            )}
            {onReset && (
              <Button type="button" variant="ghost" size="sm" isIconOnly onPress={onReset} aria-label={resetLabel}>
                <RotateCcw size={16} />
              </Button>
            )}
          </InputGroup.Suffix>
        )}
      </InputGroup>
      <Description>{helperText}</Description>
    </TextField>
  )

  const renderSecretField = ({
    id,
    label,
    helperText,
    placeholder,
    value,
    onChange
  }: SecretFieldOptions) => {
    const visible = visibleSecrets[id]
    const copied = copiedSecret === id

    return (
      <TextField fullWidth value={value} onChange={onChange}>
        <Label>{label}</Label>
        <InputGroup fullWidth variant="secondary">
          <InputGroup.Input type={visible ? 'text' : 'password'} placeholder={placeholder} />
          <InputGroup.Suffix className="pr-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              isIconOnly
              onPress={() => toggleSecretVisibility(id)}
              aria-label={visible ? '隐藏密钥' : '显示密钥'}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              isIconOnly
              onPress={() => handleCopySecret(id, value)}
              isDisabled={!value}
              aria-label={copied ? '密钥已复制' : '复制密钥'}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </Button>
          </InputGroup.Suffix>
        </InputGroup>
        <Description>{helperText}</Description>
      </TextField>
    )
  }

  const renderDatabaseTab = () => {
    return (
    <div className="tab-content space-y-8">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Typography.Heading level={3} className="text-lg font-semibold text-foreground">
            账号管理
          </Typography.Heading>
          <Button type="button" variant="primary" size="sm" onPress={handleOpenWelcomeWindow}>
            <Zap size={16} /> 新增账号
          </Button>
        </div>

        {accountsList.length > 0 ? (
          <div className="space-y-3">
            <Typography.Paragraph size="sm" color="muted">{accountsList.length} 个账号</Typography.Paragraph>

            {accountsList.map((account) => {
              const isActive = account.id === activeAccountId
              const displayName = getAccountDisplayName(account)
              const fallback = displayName.slice(0, 1).toUpperCase()

              return (
                <Card key={account.id} className="w-full items-stretch sm:flex-row">
                  <Avatar size="lg" color="accent" variant="soft" className="shrink-0 self-center">
                    {isActive && userInfo?.avatarUrl ? (
                      <Avatar.Image src={userInfo.avatarUrl} alt={displayName} />
                    ) : null}
                    <Avatar.Fallback>{fallback}</Avatar.Fallback>
                  </Avatar>

                  <div className="flex min-w-0 flex-1 flex-col gap-3">
                    <Card.Header className="gap-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Card.Title className="truncate text-base">{displayName}</Card.Title>
                        {isActive && (
                          <Chip size="sm" variant="primary" color="success">
                            <CheckCircle size={12} />
                            <Chip.Label>当前激活</Chip.Label>
                          </Chip>
                        )}
                      </div>
                      <Card.Description className="truncate">微信 ID：{account.wxid || '未设置'}</Card.Description>
                    </Card.Header>

                    <Card.Footer className="mt-auto flex w-full flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <span className="block text-xs text-muted">数据库目录</span>
                        <span className="block truncate text-sm font-medium text-foreground">
                          {account.dbPath || '未设置数据库路径'}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant={isActive ? 'outline' : 'secondary'}
                        size="sm"
                        className="w-full sm:w-auto"
                        onPress={() => handleSwitchAccountAndReconnect(account)}
                        isDisabled={isActive || isLoading}
                      >
                        <RefreshCw size={16} className={isLoading && !isActive ? 'spin' : undefined} />
                        {isActive ? '当前账号' : '切换并重连'}
                      </Button>
                    </Card.Footer>
                  </div>
                </Card>
              )
            })}
          </div>
        ) : (
          <Alert status="default">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>暂无已保存账号</Alert.Title>
              <Alert.Description>请先新增一个账号。</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
      </section>

      <Separator variant="tertiary" />

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
        <div className="space-y-8">
          <section>
            <Card className="h-fit">
              <Card.Header>
                <Card.Title>数据库配置</Card.Title>
                <Card.Description>配置微信数据库路径和解密密钥。</Card.Description>
              </Card.Header>
              <Card.Content>
                <Fieldset>
                  <Fieldset.Group className="grid gap-4">
                    {renderSecretField({
                      id: 'decryptKey',
                      label: '解密密钥',
                      helperText: '64位十六进制密钥，用于验证当前账号数据库连接',
                      placeholder: '请输入或自动获取解密密钥',
                      value: decryptKey,
                      onChange: (value) => {
                        setDecryptKey(value)
                        setIsAccountVerified(false)
                      }
                    })}
                    {renderStatus(keyStatus)}
                    {renderPathField({
                      label: '数据库根目录',
                      helperText: '选择微信账号数据所在目录，通常是 WeChat Files 的上级或包含 db_storage 的目录',
                      placeholder: '请选择微信数据库根目录',
                      value: dbPath,
                      onChange: (value) => {
                        setDbPath(value)
                        setWxid('')
                        setWxidOptions([])
                        setIsAccountVerified(false)
                      },
                      onBrowse: handleSelectDbPath
                    })}
                  </Fieldset.Group>
                </Fieldset>
              </Card.Content>
              <Card.Footer className="flex flex-wrap gap-2">
                <Button type="button" variant="primary" size="sm" onPress={handleGetKey} isDisabled={isGettingKey}>
                  <Key size={16} /> {isGettingKey ? '获取中...' : '自动获取密钥'}
                </Button>
                {isGettingKey && (
                  <Button type="button" variant="outline" size="sm" onPress={handleCancelGetKey}>
                    <X size={16} /> 取消
                  </Button>
                )}
              </Card.Footer>
            </Card>
          </section>

          <section>
            <Card className="h-fit">
              <Card.Header className="flex-row items-start justify-between gap-3">
                <div className="min-w-0">
                  <Card.Title>账号验证</Card.Title>
                  <Card.Description>确认 wxid 与数据库目录匹配。</Card.Description>
                </div>
                <Chip size="sm" variant="soft" color={isAccountVerified ? 'success' : 'warning'}>
                  <Chip.Label>{isAccountVerified ? '已验证' : '未验证'}</Chip.Label>
                </Chip>
              </Card.Header>
              <Card.Content>
                <Fieldset>
                  <Fieldset.Group className="grid gap-4">
                    <ComboBox
                      allowsCustomValue
                      fullWidth
                      inputValue={wxid}
                      selectedKey={wxidOptions.includes(wxid) ? wxid : null}
                      onInputChange={(value) => {
                        setWxid(value)
                        setIsAccountVerified(false)
                      }}
                      onSelectionChange={(key) => {
                        if (key != null) void handleSelectWxid(String(key))
                      }}
                      menuTrigger="focus"
                      variant="secondary"
                    >
                      <Label>账号验证配置</Label>
                      <ComboBox.InputGroup>
                        <Input placeholder="例如 wxid_xxxxx" variant="secondary" />
                        <ComboBox.Trigger />
                      </ComboBox.InputGroup>
                      <ComboBox.Popover>
                        <ListBox>
                          {wxidOptions.map((option) => (
                            <ListBox.Item key={option} id={option} textValue={option}>
                              {option}
                              <ListBox.ItemIndicator />
                            </ListBox.Item>
                          ))}
                        </ListBox>
                      </ComboBox.Popover>
                      <Description>请选择或填写候选账号目录，验证成功后才会作为当前账号配置保存</Description>
                    </ComboBox>
                  </Fieldset.Group>
                </Fieldset>
              </Card.Content>
              <Card.Footer className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onPress={handleScanWxid} isDisabled={isScanningWxid || !dbPath}>
                  <Search size={16} className={isScanningWxid ? 'spin' : undefined} /> {isScanningWxid ? '扫描中...' : '扫描账号'}
                </Button>
                <Button type="button" variant="outline" size="sm" onPress={handleVerifyAccountDirectory} isDisabled={isVerifyingAccount || !dbPath || !decryptKey || !wxid}>
                  <ShieldCheck size={16} /> {isVerifyingAccount ? '验证中...' : '验证账号'}
                </Button>
                <Button type="button" variant="secondary" size="sm" onPress={handleTestConnection} isDisabled={isTesting || !isAccountVerified}>
                  <Plug size={16} /> {isTesting ? '测试中...' : '测试连接'}
                </Button>
              </Card.Footer>
            </Card>
          </section>
        </div>

        <div className="space-y-8">
          <section>
            <Card className="h-fit">
              <Card.Header>
                <Card.Title>缓存目录</Card.Title>
                <Card.Description>可选配置，留空时使用默认目录。</Card.Description>
              </Card.Header>
              <Card.Content>
                {renderPathField({
                  label: '目录路径',
                  helperText: '建议选择空间充足的磁盘',
                  placeholder: '留空使用默认目录',
                  value: cachePath,
                  onChange: setCachePath,
                  onBrowse: handleSelectCachePath,
                  onReset: () => setCachePath('')
                })}
              </Card.Content>
            </Card>
          </section>

          <section>
            <Card className="h-fit">
              <Card.Header>
                <Card.Title>图片解密</Card.Title>
                <Card.Description>您只负责获取密钥，其他的交给密语-CipherTalk。</Card.Description>
              </Card.Header>
              <Card.Content>
                <Fieldset>
                  <Fieldset.Group className="grid gap-4">
                    {renderSecretField({
                      id: 'imageXorKey',
                      label: 'XOR 密钥',
                      helperText: isMac ? 'kvcomm 校验成功后返回的 XOR 密钥，格式如 0x53' : '2位十六进制，如 0x53',
                      placeholder: '例如: 0x12',
                      value: imageXorKey,
                      onChange: setImageXorKey
                    })}
                    {renderSecretField({
                      id: 'imageAesKey',
                      label: 'AES 密钥',
                      helperText: isMac ? '16位字符串；优先走 kvcomm + wxid 验真，失败才回退到内存扫描' : '至少16个字符（V4版本图片需要）',
                      placeholder: '例如: b123456789012345...',
                      value: imageAesKey,
                      onChange: setImageAesKey
                    })}
                    {renderStatus(imageKeyStatus)}
                    <Description>
                      {isMac ? '优先扫描 kvcomm 和模板文件；只有前者不可用时才回退到微信进程内存扫描。' : '请先在电脑微信中打开几张图片，再执行自动获取。'}
                    </Description>
                  </Fieldset.Group>
                </Fieldset>
              </Card.Content>
              <Card.Footer>
                <Button type="button" variant="primary" size="sm" onPress={handleGetImageKey} isDisabled={isGettingImageKey}>
                  <ImageIcon size={16} /> {isGettingImageKey ? '获取中...' : '自动获取图片密钥'}
                </Button>
              </Card.Footer>
            </Card>
          </section>
        </div>
      </div>
    </div>
    )
  }

  const [isGettingImageKey, setIsGettingImageKey] = useState(false)
  const [imageKeyStatus, setImageKeyStatus] = useState('')

  const handleGetImageKey = async () => {
    if (isGettingImageKey) return
    if (!dbPath) {
      showMessage('请先配置数据库路径', false)
      return
    }
    if (!wxid) {
      showMessage('请先配置 wxid', false)
      return
    }

    setIsGettingImageKey(true)
    setImageKeyStatus('正在从缓存目录扫描图片密钥...')

    try {
      // 构建用户目录路径（用于 wxid 匹配）
      const separator = dbPath.includes('\\') && !dbPath.includes('/') ? '\\' : '/'
      const userDir = `${dbPath.replace(/[\\/]+$/, '')}${separator}${wxid}`

      const removeListener = window.electronAPI.imageKey.onProgress((msg) => {
        setImageKeyStatus(msg)
      })

      const result = await window.electronAPI.imageKey.getImageKeys(userDir)
      removeListener()

      if (result.success) {
        if (result.xorKey !== undefined) {
          const xorKeyHex = `0x${result.xorKey.toString(16).padStart(2, '0')}`
          setImageXorKey(xorKeyHex)
        }
        if (result.aesKey) {
          setImageAesKey(result.aesKey)
        }
        showMessage('图片密钥获取成功！', true)
        setImageKeyStatus('')
      } else {
        showMessage(result.error || '获取图片密钥失败', false)
        setImageKeyStatus('')
      }
    } catch (e) {
      showMessage(`获取图片密钥失败: ${e}`, false)
      setImageKeyStatus('')
    } finally {
      setIsGettingImageKey(false)
    }
  }


  return (
    <>
      {renderDatabaseTab()}
    </>
  )
}

export default DatabaseTab
